import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  getService,
  getAllServices,
  getActiveIncidents,
  getRecentIncidents,
  getBreakingChanges,
  getBreakingChangeById,
  registerAgentClient,
  getAgentByApiKey,
  getAgentDependencies,
  setAgentDependencies,
  createAgentWebhook,
  getAgentWebhooks,
  getAgentWebhookById,
  deleteAgentWebhook,
  getWebhookDeliveries,
  WEBHOOK_EVENT_TYPES,
  recordAgentUsage,
  getAgentQuotaState,
  recordOutageSignal,
  getSystemMetrics,
  logRequest,
  getRecentRequestLog,
  getAdminOverview,
  getAgentClientById,
  setAgentTier,
  recordBillingEvent,
  upsertBillingLink,
  tryApplyBilling,
  downgradeBillingAgent
} from './db/index.js';
import { getPlan, listPlans, PLAN_TIERS } from './engine/plans.js';
import { requestLogContext } from './engine/requestContext.js';

import { scheduleTelemetryEvaluation } from './workers/telemetryLoop.js';
import { formatCompactStatusPayload } from './engine/normalizer.js';
import { evaluatePreflight } from './engine/diffEngine.js';
import { parseEndpointEntry, changeMatchesEndpoints } from './engine/endpoints.js';
import { buildPlaybook } from './engine/playbooks.js';
import { handleMcpRequest } from './mcp/server.js';
import { generateLlmsTxt, generateLlmsFullTxt } from './discovery/llms.js';
import { generateOpenApiSchema } from './discovery/openapi.js';
import { startIngestionWorker, eventBroadcaster, executeSyntheticProbe } from './workers/ingestion.js';
import { startWebhookDispatcher } from './workers/webhooks.js';

// Step 4: webhook dispatch subscribes to the domain events the DB layer
// emits from createIncident / resolveIncident / createBreakingChange.
startWebhookDispatcher();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// CORS & Security Headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match, Mcp-Method, Mcp-Name, Mcp-Session-Id, MCP-Protocol-Version, User-Agent');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Good-Citizen-Score, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Mcp-Session-Id');
}

// JSON Helper
function sendJson(res, statusCode, data, headers = {}) {
  setCorsHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  res.writeHead(statusCode);
  res.end(JSON.stringify(data, null, 2));
}

// Text Helper
function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  setCorsHeaders(res);
  res.setHeader('Content-Type', contentType);
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  res.writeHead(statusCode);
  res.end(text);
}

// Body Parser
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Raw Body Parser (Stripe webhook signature verification needs the exact
// bytes Stripe sent — a parsed/re-serialized body would not verify)
function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      length += buf.length;
      if (length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Stripe billing (Payment Links + webhook activation) ---
// Configuration is env-only: STRIPE_WEBHOOK_SECRET signs webhook events;
// STRIPE_PAYMENT_LINK_PRO / STRIPE_PAYMENT_LINK_TEAM are the checkout
// URLs. Without them, billing is disabled / plans stay operator-granted.

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  let timestamp = null;
  const signatures = [];
  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.substring(0, eq).trim();
    const value = part.substring(eq + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  return signatures.some(sig => {
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

/**
 * The per-agent checkout URL for a plan: the configured Stripe Payment
 * Link plus client_reference_id=<agent id>, so the webhook can map the
 * payment back to this agent. Null when the plan is free or no link is
 * configured for it.
 */
function checkoutUrlFor(plan, agentId) {
  let link = null;
  if (plan.tier === 'pro') link = process.env.STRIPE_PAYMENT_LINK_PRO || null;
  if (plan.tier === 'team') link = process.env.STRIPE_PAYMENT_LINK_TEAM || null;
  if (!link) return null;
  const separator = link.includes('?') ? '&' : '?';
  return `${link}${separator}client_reference_id=${encodeURIComponent(agentId)}`;
}

function billingLinksConfigured() {
  return Boolean(process.env.STRIPE_PAYMENT_LINK_PRO && process.env.STRIPE_PAYMENT_LINK_TEAM);
}

async function handleStripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return sendJson(res, 503, { error: 'billing_disabled' });
  }

  const rawBody = await parseRawBody(req);
  if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], secret)) {
    return sendJson(res, 400, { error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'invalid_payload' });
  }

  // Dedupe: Stripe redelivers on any non-2xx and occasionally at-least-once
  // duplicates a delivery; a recorded event id is acknowledged, not
  // reprocessed.
  if (event.id && !recordBillingEvent(event.id)) {
    return sendJson(res, 200, { received: true, duplicate: true });
  }

  const object = (event.data && event.data.object) || {};

  switch (event.type) {
    case 'checkout.session.completed': {
      const subscriptionId = typeof object.subscription === 'string' ? object.subscription : null;
      if (subscriptionId) {
        upsertBillingLink({
          subscription_id: subscriptionId,
          customer_id: typeof object.customer === 'string' ? object.customer : null,
          agent_id: typeof object.client_reference_id === 'string' ? object.client_reference_id : null
          // tier preserved from any subscription event already stored
        });
        tryApplyBilling(subscriptionId);
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscriptionId = typeof object.id === 'string' ? object.id : null;
      if (subscriptionId) {
        const metaTier = object.metadata && typeof object.metadata.tier === 'string'
          ? object.metadata.tier
          : null;
        upsertBillingLink({
          subscription_id: subscriptionId,
          customer_id: typeof object.customer === 'string' ? object.customer : null,
          tier: metaTier === 'pro' || metaTier === 'team' ? metaTier : null
        });
        if (object.status === 'active' || object.status === 'trialing') {
          tryApplyBilling(subscriptionId);
        } else if (object.status === 'canceled' || object.status === 'unpaid' || object.status === 'incomplete_expired') {
          downgradeBillingAgent(subscriptionId);
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscriptionId = typeof object.id === 'string' ? object.id : null;
      if (subscriptionId) {
        downgradeBillingAgent(subscriptionId);
      }
      break;
    }

    case 'invoice.payment_failed':
    default:
      // Acknowledge only: Stripe retries the payment and the follow-up
      // subscription events drive any downgrade. Unknown types likewise.
      break;
  }

  return sendJson(res, 200, { received: true });
}

// Extract Authenticated Agent & Check Rate Limit
function authenticateRequest(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  const token = parts[1];
  return getAgentByApiKey(token);
}

// --- Owner visibility: admin auth ---
// The admin surface is gated by a single bearer token from the
// ADMIN_TOKEN env var. When it is unset/empty the admin API is disabled
// entirely (503) — there is no default or fallback credential.

function checkAdminAuth(req) {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) {
    return { ok: false, status: 503, body: { error: 'admin_disabled' } };
  }
  const authHeader = req.headers['authorization'] || '';
  const parts = authHeader.split(' ');
  const provided = parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
  if (!provided) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
  const providedBuf = Buffer.from(provided);
  const configuredBuf = Buffer.from(configured);
  const matches = providedBuf.length === configuredBuf.length &&
    crypto.timingSafeEqual(providedBuf, configuredBuf);
  if (!matches) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
  return { ok: true };
}

// --- Step 3: quota enforcement + rate-limit headers ---
// Policy: only identified (authenticated) agents consume quota. Public,
// unauthenticated read endpoints stay open and uncounted — they are the
// discovery surface. A conditional request answered 304 never consumes
// quota and is never blocked (the Good Citizen incentive).

function rateLimitHeadersFor(agent) {
  const state = getAgentQuotaState(agent.id);
  if (!state) return {};
  return {
    'X-RateLimit-Limit': String(state.limit),
    'X-RateLimit-Remaining': String(state.remaining),
    'X-RateLimit-Reset': String(state.reset_epoch_seconds)
  };
}

function sendRateLimited(res, agent) {
  const state = getAgentQuotaState(agent.id);
  return sendJson(res, 429, {
    error: `Rate limit exceeded: daily quota of ${state.limit} requests exhausted. Quota resets at ${state.reset_at} (UTC midnight). Conditional requests answered 304 do not consume quota.`,
    rate_limit: {
      limit: state.limit,
      used: state.used,
      remaining: 0,
      reset_at: state.reset_at
    }
  }, {
    'Retry-After': String(state.retry_after_seconds),
    'X-RateLimit-Limit': String(state.limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(state.reset_epoch_seconds)
  });
}

/**
 * Gate for a counted authenticated request: returns true (after recording
 * one unit of usage) when the agent is within quota; sends a 429 and
 * returns false when the daily quota is exhausted.
 */
function consumeQuotaOrReject(res, agent) {
  const state = getAgentQuotaState(agent.id);
  if (state && !state.allowed) {
    sendRateLimited(res, agent);
    return false;
  }
  recordAgentUsage(agent.id, false);
  return true;
}

// --- Owner visibility: request logging ---
// Every /v1/* request (except the admin endpoints themselves) and every
// MCP tools/call gets exactly one request_log row, written when the
// response ends. Identified calls carry the agent's id+name; anonymous
// and public reads are logged with a null agent. The `counted` flag is
// flipped by recordAgentUsage (via the AsyncLocalStorage context) at the
// same place quota is consumed, so the log and the quota counter can
// never disagree. Logging is wrapped in try/catch end to end — it must
// never break the request it observes.

export async function handleRequest(req, res) {
  let pathname = req.url || '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch { /* keep raw path */ }

  const logCtx = {
    shouldLog: pathname.startsWith('/v1/') && !pathname.startsWith('/v1/admin') && !pathname.startsWith('/v1/billing'),
    logged: false,
    agentId: null,
    agentName: null,
    counted: 0,
    method: (req.method || 'GET').toUpperCase(),
    path: pathname
  };

  // Attribute up front when the caller presents a known API key; the MCP
  // gate fills this in later for api_key-argument callers.
  try {
    const agent = authenticateRequest(req);
    if (agent) {
      logCtx.agentId = agent.id;
      logCtx.agentName = agent.agent_name;
    }
  } catch { /* attribution is best-effort */ }

  const writeLogRow = () => {
    if (!logCtx.shouldLog || logCtx.logged) return;
    logCtx.logged = true;
    try {
      let agentName = logCtx.agentName;
      if (!agentName && logCtx.agentId) {
        const row = getAgentClientById(logCtx.agentId);
        if (row) agentName = row.agent_name;
      }
      logRequest({
        agent_id: logCtx.agentId,
        agent_name: agentName,
        method: logCtx.method,
        path: logCtx.path,
        status_code: res.statusCode || 200,
        counted: logCtx.counted
      });
    } catch { /* logging must never break a request */ }
  };

  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    writeLogRow();
    return originalEnd(...args);
  };
  // Long-lived responses (SSE) end via connection close, not res.end.
  if (typeof res.on === 'function') {
    res.on('close', writeLogRow);
  }

  return requestLogContext.run(logCtx, () => handleRequestInner(req, res, logCtx));
}

async function handleRequestInner(req, res, logCtx) {
  const origin = `http://${req.headers.host || 'localhost:' + PORT}`;
  const parsedUrl = new URL(req.url, origin);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle OPTIONS Preflight
  if (method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  try {
    // 1. Discovery Routes
    if (pathname === '/llms.txt' && method === 'GET') {
      const txt = generateLlmsTxt(origin);
      return sendText(res, 200, txt, 'text/plain; charset=utf-8', {
        'Cache-Control': 'public, max-age=300'
      });
    }

    if (pathname === '/llms-full.txt' && method === 'GET') {
      const txt = generateLlmsFullTxt(origin);
      return sendText(res, 200, txt, 'text/plain; charset=utf-8', {
        'Cache-Control': 'public, max-age=300'
      });
    }

    if (pathname === '/openapi.json' && method === 'GET') {
      const schema = generateOpenApiSchema(origin);
      return sendJson(res, 200, schema, {
        'Cache-Control': 'public, max-age=300'
      });
    }

    // 2. Stateless HTTP MCP Server Endpoint (/mcp)
    if (pathname === '/mcp') {
      // Streamable HTTP: this server does not offer a server-initiated
      // SSE stream on GET, so the spec-sanctioned answer is 405.
      if (method === 'GET') {
        return sendJson(res, 405, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32601, message: 'Method Not Allowed: this MCP server does not offer an SSE stream; use POST' }
        }, { Allow: 'POST' });
      }
      if (method !== 'POST') {
        return sendJson(res, 405, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32601, message: `Method Not Allowed: ${method} /mcp` }
        }, { Allow: 'POST' });
      }
      const body = await parseJsonBody(req).catch(() => ({}));
      // Owner visibility: only tools/call is logged (tools/list, ping,
      // initialize are protocol chatter, not agent usage).
      const headerMethod = req.headers['mcp-method'];
      if (headerMethod === 'tools/call' || headerMethod === 'execute' || body.method === 'tools/call') {
        logCtx.shouldLog = true;
      }
      const mcpResponse = await handleMcpRequest(req, body);
      // JSON-RPC notifications: 202 Accepted, empty body (no JSON at all).
      if (mcpResponse.empty || mcpResponse.body === null || mcpResponse.status === 202) {
        setCorsHeaders(res);
        for (const [k, v] of Object.entries(mcpResponse.headers || {})) {
          res.setHeader(k, v);
        }
        res.writeHead(202);
        return res.end();
      }
      return sendJson(res, mcpResponse.status, mcpResponse.body, mcpResponse.headers || {});
    }

    // 2b. Stripe Billing Webhook: POST /v1/billing/webhook
    // Public (authenticated by Stripe's signature, not an API key), never
    // quota-counted, and excluded from the request log like the admin
    // paths (see handleRequest). Needs the raw body — handled before any
    // JSON body parsing happens.
    if (pathname === '/v1/billing/webhook' && method === 'POST') {
      return handleStripeWebhook(req, res);
    }

    // 3. Bot Onboarding: POST /v1/agents/register
    if (pathname === '/v1/agents/register' && method === 'POST') {
      const body = await parseJsonBody(req);
      const { agent_name, operator_url } = body;

      if (!agent_name || typeof agent_name !== 'string' || agent_name.trim().length === 0) {
        return sendJson(res, 400, {
          error: 'Missing required field: agent_name (string)'
        });
      }

      if (!operator_url || typeof operator_url !== 'string' || !operator_url.startsWith('http')) {
        return sendJson(res, 400, {
          error: 'Missing or invalid operator_url (must be a valid http/https URL providing bot contact/repository)'
        });
      }

      const agent = registerAgentClient({
        agent_name: agent_name.trim(),
        operator_url: operator_url.trim()
      });

      return sendJson(res, 201, {
        message: 'Agent registered successfully. Zero-CAPTCHA verification complete.',
        agent
      });
    }

    // 3a. My Plan: GET /v1/agents/me/plan
    // The caller's current tier/quota state plus the full plan catalog.
    // A read of the agent's own billing state: it does NOT consume quota.
    if (pathname === '/v1/agents/me/plan' && method === 'GET') {
      const agent = authenticateRequest(req);
      if (!agent) {
        return sendJson(res, 401, {
          error: 'Unauthorized: a valid API key is required (Authorization: Bearer agp_live_...). Register at POST /v1/agents/register.'
        });
      }
      const state = getAgentQuotaState(agent.id);
      const plans = listPlans().map(plan => ({
        ...plan,
        checkout_url: checkoutUrlFor(plan, agent.id)
      }));
      return sendJson(res, 200, {
        tier: agent.tier,
        daily_quota: state ? state.limit : agent.daily_quota,
        requests_today: state ? state.used : 0,
        quota_remaining: state ? state.remaining : agent.daily_quota,
        plans,
        upgrade: {
          how: billingLinksConfigured()
            ? 'Open your plan\'s checkout_url and complete the Stripe checkout — keep the client_reference_id in the URL so your plan activates automatically on payment. Cancellation downgrades automatically.'
            : 'Paid plans are activated by the operator after purchase — see website',
          url: 'https://agentpulse-43di.onrender.com'
        }
      }, rateLimitHeadersFor(agent));
    }

    // 3b. Dependency Manifests: GET/PUT /v1/agents/me/dependencies (Step 2)
    if (pathname === '/v1/agents/me/dependencies' && (method === 'GET' || method === 'PUT')) {
      const agent = authenticateRequest(req);
      if (!agent) {
        return sendJson(res, 401, {
          error: 'Unauthorized: a valid API key is required (Authorization: Bearer agp_live_...). Register at POST /v1/agents/register.'
        });
      }
      if (!consumeQuotaOrReject(res, agent)) return;

      if (method === 'GET') {
        const dependencies = getAgentDependencies(agent.id);
        return sendJson(res, 200, {
          agent_id: agent.id,
          count: dependencies.length,
          dependencies
        }, rateLimitHeadersFor(agent));
      }

      // PUT: replace-all manifest update
      const body = await parseJsonBody(req);
      const deps = body.dependencies;

      if (!Array.isArray(deps)) {
        return sendJson(res, 400, {
          error: 'Missing required field: dependencies (array of { service, package?, version?, endpoints? })'
        });
      }

      for (const dep of deps) {
        if (!dep || typeof dep.service !== 'string' || dep.service.trim().length === 0) {
          return sendJson(res, 400, {
            error: 'Each dependency must include a service slug (string).'
          });
        }
        if (dep.package !== undefined && dep.package !== null && typeof dep.package !== 'string') {
          return sendJson(res, 400, {
            error: `Invalid package for service '${dep.service.trim().toLowerCase()}': must be a string.`
          });
        }
        if (dep.version !== undefined && dep.version !== null && typeof dep.version !== 'string') {
          return sendJson(res, 400, {
            error: `Invalid version for service '${dep.service.trim().toLowerCase()}': must be a string.`
          });
        }
        if (dep.endpoints !== undefined && dep.endpoints !== null) {
          const badEndpoints = !Array.isArray(dep.endpoints)
            || dep.endpoints.some(e => parseEndpointEntry(e) === null);
          if (badEndpoints) {
            return sendJson(res, 400, {
              error: `Invalid endpoints for service '${dep.service.trim().toLowerCase()}': must be an array of "METHOD /path" or "/path" strings.`
            });
          }
        }
        const slug = dep.service.trim().toLowerCase();
        if (!getService(slug)) {
          return sendJson(res, 400, {
            error: `Unknown service slug: '${slug}'. See GET /v1/services for supported services.`,
            unknown_service: slug
          });
        }
      }

      const stored = setAgentDependencies(agent.id, deps);
      return sendJson(res, 200, {
        message: 'Dependency manifest stored. Preflight, the changes feed (scope=mine), and the MCP get_my_impact tool now answer for your stack.',
        agent_id: agent.id,
        count: stored.length,
        dependencies: stored
      }, rateLimitHeadersFor(agent));
    }

    // 3c. Webhook Subscriptions: /v1/agents/me/webhooks[/:id[/deliveries]] (Step 4)
    const webhooksMatch = pathname.match(/^\/v1\/agents\/me\/webhooks(?:\/([a-zA-Z0-9_\-]+)(\/deliveries)?)?$/);
    if (webhooksMatch && (method === 'GET' || method === 'POST' || method === 'DELETE')) {
      const agent = authenticateRequest(req);
      if (!agent) {
        return sendJson(res, 401, {
          error: 'Unauthorized: a valid API key is required (Authorization: Bearer agp_live_...). Register at POST /v1/agents/register.'
        });
      }
      if (!consumeQuotaOrReject(res, agent)) return;
      const rlHeaders = rateLimitHeadersFor(agent);
      const webhookId = webhooksMatch[1] || null;
      const isDeliveries = Boolean(webhooksMatch[2]);

      // GET /v1/agents/me/webhooks/:id/deliveries — recent delivery log
      if (isDeliveries) {
        if (method !== 'GET') {
          return sendJson(res, 404, { error: `Endpoint not found: ${method} ${pathname}` });
        }
        const webhook = getAgentWebhookById(agent.id, webhookId);
        if (!webhook) {
          return sendJson(res, 404, { error: `Webhook '${webhookId}' not found for this agent.` });
        }
        const deliveries = getWebhookDeliveries(webhookId, 20);
        return sendJson(res, 200, {
          webhook_id: webhookId,
          count: deliveries.length,
          deliveries
        }, rlHeaders);
      }

      // POST /v1/agents/me/webhooks — create (secret shown only in this response)
      if (method === 'POST' && !webhookId) {
        const body = await parseJsonBody(req);
        const { url, events, services } = body;

        if (!url || typeof url !== 'string') {
          return sendJson(res, 400, { error: 'Missing required field: url (string)' });
        }
        let parsedUrl;
        try {
          parsedUrl = new URL(url);
        } catch {
          return sendJson(res, 400, { error: `Invalid webhook url: '${url}'` });
        }
        const isLocalHttp = parsedUrl.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedUrl.hostname);
        if (parsedUrl.protocol !== 'https:' && !isLocalHttp) {
          return sendJson(res, 400, {
            error: 'Webhook url must use https:// (http:// is only allowed for localhost / 127.0.0.1 during development).'
          });
        }

        if (events !== undefined) {
          if (!Array.isArray(events) || events.length === 0 || events.some(e => !WEBHOOK_EVENT_TYPES.includes(e))) {
            return sendJson(res, 400, {
              error: `events must be a non-empty array drawn from: ${WEBHOOK_EVENT_TYPES.join(', ')}`,
              allowed_events: WEBHOOK_EVENT_TYPES
            });
          }
        }

        let serviceFilter = null;
        if (services !== undefined && services !== null) {
          if (!Array.isArray(services) || services.some(s => typeof s !== 'string' || s.trim().length === 0)) {
            return sendJson(res, 400, {
              error: 'services must be an array of service slugs (omit or pass null for all services).'
            });
          }
          serviceFilter = services.map(s => s.trim().toLowerCase());
          for (const slug of serviceFilter) {
            if (!getService(slug)) {
              return sendJson(res, 400, {
                error: `Unknown service slug: '${slug}'. See GET /v1/services for supported services.`,
                unknown_service: slug
              });
            }
          }
          if (serviceFilter.length === 0) serviceFilter = null;
        }

        const webhook = createAgentWebhook({
          agent_id: agent.id,
          url,
          events: events || null,
          services: serviceFilter
        });

        return sendJson(res, 201, {
          message: 'Webhook created. Store the secret now — it is shown only in this response and is required to verify delivery signatures (X-AgentPulse-Signature).',
          webhook
        }, rlHeaders);
      }

      // GET /v1/agents/me/webhooks — list (never includes secrets)
      if (method === 'GET' && !webhookId) {
        const webhooks = getAgentWebhooks(agent.id);
        return sendJson(res, 200, {
          agent_id: agent.id,
          count: webhooks.length,
          webhooks
        }, rlHeaders);
      }

      // DELETE /v1/agents/me/webhooks/:id — delete own webhook
      if (method === 'DELETE' && webhookId) {
        const deleted = deleteAgentWebhook(agent.id, webhookId);
        if (!deleted) {
          return sendJson(res, 404, { error: `Webhook '${webhookId}' not found for this agent.` });
        }
        return sendJson(res, 200, {
          message: 'Webhook deleted. No further deliveries will be sent to it.',
          id: webhookId
        }, rlHeaders);
      }

      return sendJson(res, 404, { error: `Endpoint not found: ${method} ${pathname}` });
    }

    // 4. Batch Preflight: POST /v1/preflight
    if (pathname === '/v1/preflight' && method === 'POST') {
      const agent = authenticateRequest(req);
      let rlHeaders = {};
      if (agent) {
        if (!consumeQuotaOrReject(res, agent)) return;
        rlHeaders = rateLimitHeadersFor(agent);
      }

      const body = await parseJsonBody(req);
      const dependencies = body.dependencies || [];

      const preflight = evaluatePreflight(dependencies, agent ? agent.id : null);
      return sendJson(res, 200, preflight, {
        'Cache-Control': 'public, max-age=15',
        ...rlHeaders
      });
    }

    // 5. Core Query: GET /v1/status/:service
    const statusMatch = pathname.match(/^\/v1\/status\/([a-zA-Z0-9_\-]+)$/);
    if (statusMatch && method === 'GET') {
      const slug = statusMatch[1].toLowerCase();
      const service = getService(slug);

      if (!service) {
        return sendJson(res, 404, {
          error: `Service '${slug}' not found. Supported services include: stripe, openai, anthropic, github, aws, supabase, vercel, cloudflare, resend, datadog, pinecone, npm.`
        });
      }

      // Check ETag caching & 304 Not Modified
      const clientEtag = req.headers['if-none-match'];
      const isEtagMatch = clientEtag && (clientEtag === service.etag || clientEtag === `W/${service.etag}`);

      const agent = authenticateRequest(req);
      let rlHeaders = {};
      if (agent) {
        if (isEtagMatch) {
          // 304: Good Citizen score reward only — consumes no quota and is
          // never blocked, even when the agent is at its daily limit.
          recordAgentUsage(agent.id, true);
        } else if (!consumeQuotaOrReject(res, agent)) {
          return;
        }
        rlHeaders = rateLimitHeadersFor(agent);
      }

      const responseHeaders = {
        ETag: service.etag,
        'Cache-Control': 'public, max-age=15, stale-while-revalidate=45',
        'X-Good-Citizen-Score': agent ? String(agent.good_citizen_score + (isEtagMatch ? 2 : 0)) : '100',
        ...rlHeaders
      };

      if (isEtagMatch) {
        setCorsHeaders(res);
        for (const [k, v] of Object.entries(responseHeaders)) {
          res.setHeader(k, v);
        }
        res.writeHead(304);
        return res.end();
      }

      const activeIncidents = getActiveIncidents(slug);
      // Filter breaking changes to very recent (last 48 hours) to preserve the < 150 token budget
      const recentThreshold = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const breaking = getBreakingChanges(slug, recentThreshold);
      const compactPayload = formatCompactStatusPayload(service, activeIncidents, breaking);

      return sendJson(res, 200, compactPayload, responseHeaders);
    }

    // 5b. Migration Playbook: GET /v1/changes/:id/playbook (Step 6)
    // Public read, like the changes feed itself: a playbook contains no
    // agent-specific data, only the change's own fields expanded into steps.
    const playbookMatch = pathname.match(/^\/v1\/changes\/([a-zA-Z0-9_\-]+)\/playbook$/);
    if (playbookMatch && method === 'GET') {
      const change = getBreakingChangeById(playbookMatch[1]);
      if (!change) {
        return sendJson(res, 404, {
          error: `Breaking change '${playbookMatch[1]}' not found. See GET /v1/changes for recorded changes.`
        });
      }
      return sendJson(res, 200, {
        playbook: buildPlaybook(change)
      }, {
        'Cache-Control': 'public, max-age=300'
      });
    }

    // 6. Delta Feed: GET /v1/changes?since={iso_ts}[&scope=mine]
    if (pathname === '/v1/changes' && method === 'GET') {
      const since = parsedUrl.searchParams.get('since') || null;
      const service = parsedUrl.searchParams.get('service') || null;
      const scope = (parsedUrl.searchParams.get('scope') || 'all').toLowerCase();

      // Step 2: scope=mine restricts the feed to the caller's manifest services
      if (scope === 'mine') {
        const agent = authenticateRequest(req);
        if (!agent) {
          return sendJson(res, 401, {
            error: 'Unauthorized: scope=mine requires a valid API key (Authorization: Bearer agp_live_...).'
          });
        }
        if (!consumeQuotaOrReject(res, agent)) return;

        const manifestBySlug = new Map(getAgentDependencies(agent.id).map(d => [d.service, d.endpoints]));
        const changes = getBreakingChanges(service, since)
          .filter(c => manifestBySlug.has(c.service_slug) && changeMatchesEndpoints(c, manifestBySlug.get(c.service_slug)))
          .map(c => ({ ...c, playbook_url: `${origin}/v1/changes/${c.id}/playbook` }));
        return sendJson(res, 200, {
          count: changes.length,
          since: since || 'all_recorded',
          service_filter: service || 'all',
          scope: 'mine',
          changes
        }, rateLimitHeadersFor(agent));
      }

      const changes = getBreakingChanges(service, since)
        .map(c => ({ ...c, playbook_url: `${origin}/v1/changes/${c.id}/playbook` }));
      return sendJson(res, 200, {
        count: changes.length,
        since: since || 'all_recorded',
        service_filter: service || 'all',
        changes
      });
    }

    // 7. List All Services: GET /v1/services
    if (pathname === '/v1/services' && method === 'GET') {
      const services = getAllServices();
      return sendJson(res, 200, {
        count: services.length,
        services
      });
    }

    // 8. Incidents Feed: GET /v1/incidents
    if (pathname === '/v1/incidents' && method === 'GET') {
      const activeOnly = parsedUrl.searchParams.get('active_only') !== 'false';
      const incidents = activeOnly ? getActiveIncidents() : getRecentIncidents(50);
      return sendJson(res, 200, {
        count: incidents.length,
        active_only: activeOnly,
        incidents
      });
    }

    // 9. Crowdsourced Telemetry: POST /v1/telemetry/report
    // Step 3: writes must be attributable — a valid API key is required.
    if (pathname === '/v1/telemetry/report' && method === 'POST') {
      const agent = authenticateRequest(req);
      if (!agent) {
        return sendJson(res, 401, {
          error: 'Unauthorized: telemetry reports require a valid API key (Authorization: Bearer agp_live_...). Register at POST /v1/agents/register.'
        });
      }
      if (!consumeQuotaOrReject(res, agent)) return;

      const body = await parseJsonBody(req);
      const { service, endpoint, error_code, error_type } = body;

      if (!service || !endpoint || !error_code) {
        return sendJson(res, 400, {
          error: 'Missing required telemetry fields: service, endpoint, error_code'
        });
      }

      const record = recordOutageSignal({
        service_slug: service,
        agent_id: agent.id,
        endpoint,
        error_code: parseInt(error_code, 10),
        error_type
      });

      // Step 2 telemetry loop: clustered reports can trigger an out-of-cycle
      // spec re-check. Fire-and-forget — never blocks or breaks the 202.
      scheduleTelemetryEvaluation(service);

      return sendJson(res, 202, {
        message: 'Outage signal recorded',
        signal: record
      }, rateLimitHeadersFor(agent));
    }

    // 10. Live SSE Stream: GET /v1/stream
    if (pathname === '/v1/stream' && method === 'GET') {
      setCorsHeaders(res);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.writeHead(200);

      // Send initial connect frame
      res.write(`event: connected\ndata: ${JSON.stringify({ connected_at: new Date().toISOString() })}\n\n`);

      const onIncident = data => {
        res.write(`event: incident\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const onHeartbeat = data => {
        res.write(`event: heartbeat\ndata: ${JSON.stringify(data)}\n\n`);
      };

      eventBroadcaster.on('incident', onIncident);
      eventBroadcaster.on('heartbeat', onHeartbeat);

      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15000);

      req.on('close', () => {
        clearInterval(keepAlive);
        eventBroadcaster.removeListener('incident', onIncident);
        eventBroadcaster.removeListener('heartbeat', onHeartbeat);
      });
      return;
    }

    // 11. Metrics: GET /v1/metrics
    if (pathname === '/v1/metrics' && method === 'GET') {
      const metrics = getSystemMetrics();
      return sendJson(res, 200, metrics);
    }

    // 12. Synthetic Probe Trigger (Manual): POST /v1/synthetic/probe
    // Step 3: this trigger writes probe rows and mutates service latency, so
    // it now requires a valid API key like every other write.
    if (pathname === '/v1/synthetic/probe' && method === 'POST') {
      const agent = authenticateRequest(req);
      if (!agent) {
        return sendJson(res, 401, {
          error: 'Unauthorized: triggering a synthetic probe requires a valid API key (Authorization: Bearer agp_live_...).'
        });
      }
      if (!consumeQuotaOrReject(res, agent)) return;

      const body = await parseJsonBody(req);
      const service = body.service || 'stripe';
      const result = await executeSyntheticProbe(service);
      return sendJson(res, 200, result, rateLimitHeadersFor(agent));
    }

    // 12b. Owner Visibility: admin API + owner page (Step: admin)
    // These routes are deliberately excluded from the request log (see
    // handleRequest) so owner traffic never pollutes agent usage data.
    if (pathname === '/v1/admin/agents' && method === 'GET') {
      const auth = checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, auth.status, auth.body);
      const overview = getAdminOverview();
      return sendJson(res, 200, {
        generated_at: new Date().toISOString(),
        totals: overview.totals,
        agents: overview.agents
      });
    }

    // Owner plan grant: PATCH /v1/admin/agents/:id { tier }
    // How paid plans are activated today (no self-serve checkout yet):
    // the operator grants a plan after purchase; tier AND daily_quota are
    // set from the plan catalog (src/engine/plans.js).
    const adminAgentMatch = pathname.match(/^\/v1\/admin\/agents\/([a-zA-Z0-9_\-]+)$/);
    if (adminAgentMatch && method === 'PATCH') {
      const auth = checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, auth.status, auth.body);

      let body;
      try {
        body = await parseJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON payload' });
      }

      const tier = body ? body.tier : undefined;
      if (typeof tier !== 'string' || !getPlan(tier)) {
        return sendJson(res, 400, {
          error: `Invalid tier: expected one of ${PLAN_TIERS.join(', ')}`,
          allowed_tiers: PLAN_TIERS
        });
      }

      const updated = setAgentTier(adminAgentMatch[1], tier);
      if (!updated) {
        return sendJson(res, 404, { error: `Agent '${adminAgentMatch[1]}' not found.` });
      }
      return sendJson(res, 200, updated);
    }

    if (pathname === '/v1/admin/requests' && method === 'GET') {
      const auth = checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, auth.status, auth.body);
      const rawLimit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
      const requests = getRecentRequestLog(limit);
      return sendJson(res, 200, {
        generated_at: new Date().toISOString(),
        count: requests.length,
        requests
      });
    }

    // Owner plan catalog: the /admin page renders its Plans section and
    // per-agent plan controls from this — the catalog itself stays in
    // src/engine/plans.js and is never hardcoded in the page.
    if (pathname === '/v1/admin/plans' && method === 'GET') {
      const auth = checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, auth.status, auth.body);
      return sendJson(res, 200, { plans: listPlans() });
    }

    if (pathname === '/admin' && method === 'GET') {
      const adminPath = path.join(PUBLIC_DIR, 'admin.html');
      if (fs.existsSync(adminPath)) {
        const adminContent = fs.readFileSync(adminPath);
        return sendText(res, 200, adminContent, 'text/html; charset=utf-8');
      }
      return sendText(res, 404, 'Admin page not found');
    }

    // 13. Static Frontend Assets Serving
    if (method === 'GET') {
      let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

      // Security check against directory traversal
      if (!filePath.startsWith(PUBLIC_DIR)) {
        return sendText(res, 403, 'Forbidden');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const fileContent = fs.readFileSync(filePath);
        return sendText(res, 200, fileContent, contentType);
      }

      // SPA Fallback: Serve index.html for unknown HTML paths
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath);
        return sendText(res, 200, indexContent, 'text/html; charset=utf-8');
      }
    }

    // 404 Route Not Found
    return sendJson(res, 404, {
      error: `Endpoint not found: ${method} ${pathname}`,
      discovery: `${origin}/llms.txt`,
      openapi: `${origin}/openapi.json`
    });

  } catch (err) {
    console.error('[Server Error]:', err);
    return sendJson(res, 500, {
      error: 'Internal Server Error',
      message: err.message
    });
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

// Start Server when invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`================================================================`);
    console.log(`🚀 AgentPulse Oracle Edge Server running at http://${HOST}:${PORT}`);
    console.log(`🤖 llms.txt Discovery: http://${HOST}:${PORT}/llms.txt`);
    console.log(`📡 Stateless HTTP MCP: http://${HOST}:${PORT}/mcp`);
    console.log(`📖 Strict OpenAPI:     http://${HOST}:${PORT}/openapi.json`);
    console.log(`================================================================`);
    startIngestionWorker(60000);
  });
}
