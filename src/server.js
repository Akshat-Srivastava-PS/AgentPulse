import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getService,
  getAllServices,
  getActiveIncidents,
  getRecentIncidents,
  getBreakingChanges,
  registerAgentClient,
  getAgentByApiKey,
  recordAgentUsage,
  recordOutageSignal,
  getSystemMetrics
} from './db/index.js';

import { formatCompactStatusPayload } from './engine/normalizer.js';
import { evaluatePreflight } from './engine/diffEngine.js';
import { handleMcpRequest } from './mcp/server.js';
import { generateLlmsTxt, generateLlmsFullTxt } from './discovery/llms.js';
import { generateOpenApiSchema } from './discovery/openapi.js';
import { startIngestionWorker, eventBroadcaster, executeSyntheticProbe } from './workers/ingestion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// CORS & Security Headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match, Mcp-Method, Mcp-Name, User-Agent');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Good-Citizen-Score, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
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

export async function handleRequest(req, res) {
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
      const body = method === 'POST' ? await parseJsonBody(req).catch(() => ({})) : {};
      const mcpResponse = await handleMcpRequest(req, body);
      return sendJson(res, mcpResponse.status, mcpResponse.body);
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

    // 4. Batch Preflight: POST /v1/preflight
    if (pathname === '/v1/preflight' && method === 'POST') {
      const agent = authenticateRequest(req);
      if (agent) {
        recordAgentUsage(agent.id, false);
      }

      const body = await parseJsonBody(req);
      const dependencies = body.dependencies || [];

      const preflight = evaluatePreflight(dependencies);
      return sendJson(res, 200, preflight, {
        'Cache-Control': 'public, max-age=15'
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
      if (agent) {
        recordAgentUsage(agent.id, isEtagMatch);
      }

      const responseHeaders = {
        ETag: service.etag,
        'Cache-Control': 'public, max-age=15, stale-while-revalidate=45',
        'X-Good-Citizen-Score': agent ? String(agent.good_citizen_score + (isEtagMatch ? 2 : 0)) : '100'
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

    // 6. Delta Feed: GET /v1/changes?since={iso_ts}
    if (pathname === '/v1/changes' && method === 'GET') {
      const since = parsedUrl.searchParams.get('since') || null;
      const service = parsedUrl.searchParams.get('service') || null;

      const changes = getBreakingChanges(service, since);
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
    if (pathname === '/v1/telemetry/report' && method === 'POST') {
      const agent = authenticateRequest(req);
      const body = await parseJsonBody(req);
      const { service, endpoint, error_code, error_type } = body;

      if (!service || !endpoint || !error_code) {
        return sendJson(res, 400, {
          error: 'Missing required telemetry fields: service, endpoint, error_code'
        });
      }

      const record = recordOutageSignal({
        service_slug: service,
        agent_id: agent ? agent.id : null,
        endpoint,
        error_code: parseInt(error_code, 10),
        error_type
      });

      return sendJson(res, 202, {
        message: 'Signal accepted into anomaly detection pipeline',
        signal: record
      });
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

    // 12. Synthetic Probe Trigger (Test / Manual): POST /v1/synthetic/probe
    if (pathname === '/v1/synthetic/probe' && method === 'POST') {
      const body = await parseJsonBody(req);
      const service = body.service || 'stripe';
      const result = await executeSyntheticProbe(service);
      return sendJson(res, 200, result);
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
