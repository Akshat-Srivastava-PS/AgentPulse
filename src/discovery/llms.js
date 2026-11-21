/**
 * LLMS.txt and LLMS-Full.txt generators adhering to the https://llmstxt.org specification
 */

export function generateLlmsTxt(origin = 'https://agentpulse.dev') {
  return `# AgentPulse

> Real-time ground-truth hub and breaking-change oracle for autonomous AI agents, coding assistants (Claude Code, Cursor, Cline), and CI bots. Verifies API availability, active 5xx incidents, and SDK schema deprecations in < 150 tokens with sub-50ms latency before bots burn tokens retrying broken endpoints.

## Core API & Discovery
- [OpenAPI 3.1 Specification](${origin}/openapi.json): Strict machine-readable API definitions for autonomous tool calling.
- [Full Agent Context Documentation](${origin}/llms-full.txt): Complete operational guide, payload schemas, and client retry policies.
- [Self-Serve Bot Onboarding](${origin}/v1/agents/register): Zero-CAPTCHA programmatic API key issuance (100 requests/day free tier).

## Essential Preflight & Status Tools
- [Batch Preflight Check](${origin}/v1/preflight): POST dependency list (e.g. ["stripe", "supabase", "resend"]) to obtain immediate pass/degraded/block verdict.
- [Service Status Query](${origin}/v1/status/stripe): GET compact health status, active incidents, affected scope, and prescriptive agent_hint (< 150 tokens).
- [Delta Feed of Breaking Changes](${origin}/v1/changes): GET recent SDK deprecations and schema mutations since timestamp checkpoint. Add \`?scope=mine\` (auth required) to restrict the feed to your manifest services. Every change carries a \`playbook_url\`.
- [Migration Playbook](${origin}/v1/changes/{id}/playbook): GET a structured migration playbook for one breaking change: \`{ change_id, service, kind, summary, steps: [{ action, detail, code_example? }], effort_estimate, risk_notes }\`, generated from the change's own fields (operation, path, parameter/property names, types) — generic templates, no invented vendor facts.
- [JavaScript SDK](https://www.npmjs.com/package/agentpulse-sdk): \`npm install agentpulse-sdk\` — zero-dependency client (global fetch only) wrapping this API with ETag caching and typed errors, for agents that prefer plain functions over MCP. Source: \`sdk/\` in the AgentPulse repo.
- [All Monitored Services](${origin}/v1/services): Full catalog of tracked cloud providers, APIs, and registries.
- [Live Incident Feed](${origin}/v1/incidents): Active incidents with severity ratings and mitigation hints.

## My Dependency Manifest & Affected Answers (Auth Required)
- [Dependency Manifest](${origin}/v1/agents/me/dependencies): \`PUT\` replaces your stored manifest: \`{"dependencies": [{"service": "stripe", "package": "stripe", "version": "14.5.0"}]}\` (package/version optional; unknown slugs rejected with 400). \`GET\` returns it. Once set, preflight adds a compact \`impact\` verdict ({ affected, incident_ids, change_ids, reason }) per manifest service — affected means an active incident or a breaking change from the last 90 days touches your stack.

## Webhook Alerts (Auth Required)
- [Webhooks](${origin}/v1/agents/me/webhooks): \`POST\` subscribes a URL to \`incident.created\`, \`incident.resolved\`, and \`change.detected\` events (optionally filtered by \`services\` slugs — set it to your manifest services to hear only about your stack; omitted = all services). The create response shows the signing \`secret\` ONCE. Every delivery is a POST of \`{"id", "type", "created_at", "data"}\` with headers \`X-AgentPulse-Event\`, \`X-AgentPulse-Delivery\`, and \`X-AgentPulse-Signature: sha256=<HMAC-SHA256 hex of the raw body, keyed with your secret>\` — verify it before trusting a payload. \`GET\` lists your webhooks (no secrets), \`DELETE /v1/agents/me/webhooks/{id}\` removes one, \`GET /v1/agents/me/webhooks/{id}/deliveries\` shows the last 20 delivery attempts. URLs must be https (http allowed only for localhost). Deliveries retry up to 3 attempts with backoff.

## Stateless HTTP MCP Server
- [Stateless MCP Endpoint](${origin}/mcp): Streamable Model Context Protocol endpoint supporting both JSON-RPC 2.0 and Mcp-Method / Mcp-Name header routing. Send \`Authorization: Bearer <api_key>\` to identify your agent.
  - \`check_dependency_health\`: Mid-debugging stack health preflight (manifest-aware when authenticated).
  - \`lookup_breaking_changes\`: Deprecation and schema diff analyzer.
  - \`get_service_status\`: Instant single-service health check.
  - \`get_my_impact\`: Affected verdicts for every service in your stored dependency manifest (auth required; api_key argument accepted as fallback).
  - \`report_outage_signal\`: Crowdsource early 5xx anomaly detection.

## Good Citizen Protocol
- **ETag & 304 Not Modified**: Always pass \`If-None-Match: <etag>\` in subsequent requests. A 304 response costs 0 tokens, grants +2 points to your Good Citizen Score, and **does not consume daily quota** — conditional requests are never blocked, even at your limit. Your Good Citizen Score is reputational — the free-tier quota is a flat 100 counted requests/day for every agent and does not expand; higher volume is a paid tier.

## Pricing
- **Free** (\`free_verified\`): 100 counted requests/day, flat for every agent. Zero-CAPTCHA registration, no card.
- **Pro**: 10,000 counted requests/day — $29/month.
- **Team**: 50,000 counted requests/day — $99/month.
- Paid plans are **activated by the operator after purchase** — there is no self-serve checkout yet. If you need a paid plan, have your operator contact us via https://agentpulse-43di.onrender.com and we will activate it on your existing API key. Check your current tier, usage, and the full plan list any time at \`GET /v1/agents/me/plan\` (auth required; reading your plan does not consume quota).

## Quotas & Auth (Enforced)
- **Daily quota**: free tier 100 counted requests/day, resetting at UTC midnight. Only identified (API-key) calls count; public unauthenticated reads (\`/v1/status/*\`, \`/v1/services\`, \`/v1/incidents\`, \`/v1/changes\`, discovery) stay open and uncounted.
- **429 responses**: an exhausted quota returns \`429\` with \`Retry-After\` (seconds to reset) and a \`rate_limit\` body. Authenticated responses carry \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, and \`X-RateLimit-Reset\` (epoch seconds) headers.
- **Writes require your API key**: \`PUT /v1/agents/me/dependencies\`, \`POST /v1/telemetry/report\`, \`POST /v1/synthetic/probe\`, and the MCP \`report_outage_signal\` tool all reject anonymous callers with 401. Registration itself stays zero-CAPTCHA and open.
`;
}

export function generateLlmsFullTxt(origin = 'https://agentpulse.dev') {
  return `# AgentPulse: Complete Agent Integration Guide

## 1. Executive Summary
AgentPulse is an ultra-low latency, token-optimized oracle built specifically for autonomous AI agents (Claude Code, Cursor, Codex, Windsurf, Devops bots). It prevents agents from getting stuck in multi-minute hallucinated retry loops when third-party cloud dependencies (Stripe, OpenAI, AWS, GitHub, Supabase, Vercel) encounter 500/502 outages or silent SDK deprecations.

## 2. Authentication & Good Citizen Protocol
- **Zero-CAPTCHA Registration**:
  \`POST /v1/agents/register\`
  Headers: \`User-Agent: YourAgentName/1.0\`, \`Content-Type: application/json\`
  Body: \`{"agent_name": "MyCodingAgent", "operator_url": "https://github.com/myorg/bot"}\`
  Response: \`{"api_key": "agp_live_...", "tier": "free_verified", "daily_quota": 100, "good_citizen_score": 100}\`

- **Header Authentication**:
  Pass \`Authorization: Bearer agp_live_...\` with all queries.

- **Good Citizen Protocol (ETag 304 Caching)**:
  Every status response includes a strong/weak \`ETag\` header (e.g. \`W/"a1b2c3d4e5f6"\`).
  When querying \`GET /v1/status/{service}\`, bots should supply \`If-None-Match: W/"a1b2c3d4e5f6"\`.
  If the service state has not mutated:
  - Server returns \`HTTP 304 Not Modified\` with an empty body (0 tokens consumed!).
  - The 304 **does not count toward your daily quota** and is served even when the quota is exhausted.
  - Bot receives \`+2\` to its \`good_citizen_score\`.
  - The score is reputational only: the free-tier quota stays a flat 100 counted requests/day at every score. Higher volume requires a paid tier.

- **Quota Enforcement (Step 3)**:
  Daily quotas are enforced for identified agents (REST and MCP tool calls alike):
  - Counted: authenticated \`GET /v1/status/{service}\` (200 only), \`POST /v1/preflight\`, manifest \`GET\`/\`PUT\`, \`GET /v1/changes?scope=mine\`, \`POST /v1/telemetry/report\`, \`POST /v1/synthetic/probe\`, and identified MCP \`tools/call\` executions.
  - Never counted: 304 responses, and all unauthenticated public reads (status, services, incidents, changes, metrics, stream, discovery documents).
  - Exhaustion returns \`HTTP 429\` with \`Retry-After: <seconds to UTC midnight>\` and a JSON body \`{"error": "Rate limit exceeded...", "rate_limit": {"limit", "used", "remaining": 0, "reset_at"}}\`.
  - Authenticated responses include \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, and \`X-RateLimit-Reset\` (Unix epoch seconds of the next UTC-midnight reset).

- **Write Authentication (Step 3)**:
  Every mutating route except registration requires \`Authorization: Bearer agp_live_...\`:
  \`PUT /v1/agents/me/dependencies\`, \`POST /v1/telemetry/report\`, \`POST /v1/synthetic/probe\`, and the MCP \`report_outage_signal\` tool (identity via the Authorization header or its \`api_key\` argument). Anonymous writes receive \`401\`.

## 3. Endpoints & Schemas

### Batch Preflight (\`POST /v1/preflight\`)
Send dependencies before beginning multi-step code generation or autonomous CI tasks:
\`\`\`bash
curl -X POST "${origin}/v1/preflight" \\
  -H "Authorization: Bearer <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"dependencies": ["stripe", "supabase", "resend"]}'
\`\`\`

Example response (illustrative shape — live responses carry only real ingested incidents and changes):
\`\`\`json
{
  "verdict": "degraded",
  "healthy": false,
  "checked_at": "2026-11-20T22:56:00Z",
  "total_requested": 3,
  "outage_count": 0,
  "degraded_count": 1,
  "recommendation": "WARNING: 1 dependency degraded. Recommended action: stripe: Use exponential backoff (min 15s) or defer non-urgent retries.",
  "services": {
    "stripe": {
      "status": "degraded",
      "tracked": true,
      "latency_ms": 184.2,
      "active_incidents_count": 1,
      "compact": {
        "service": "stripe",
        "status": "degraded",
        "updated_at": "2026-11-20T22:55:00Z",
        "active_incidents": [
          {
            "id": "inc_9821",
            "severity": "major",
            "scope": "POST /v1/payment_intents (us-east-1)",
            "summary": "Elevated 502 error rate (~18%) starting 22:41 UTC.",
            "agent_hint": "Use exponential backoff (min 15s) or defer non-urgent retries."
          }
        ],
        "recent_breaking_changes": []
      }
    },
    "supabase": { "status": "operational", "tracked": true },
    "resend": { "status": "operational", "tracked": true }
  }
}
\`\`\`

### Single Service Status (\`GET /v1/status/{service}\`)
Compact (< 150 token) response (example values are illustrative; live responses carry only real ingested data):
\`\`\`json
{
  "service": "stripe",
  "status": "degraded",
  "updated_at": "2026-11-20T22:55:00Z",
  "active_incidents": [
    {
      "id": "inc_9821",
      "severity": "major",
      "scope": "POST /v1/payment_intents (us-east-1)",
      "summary": "Elevated 502 error rate (~18%) starting 22:41 UTC.",
      "agent_hint": "Use exponential backoff (min 15s) or defer non-urgent retries."
    }
  ],
  "recent_breaking_changes": []
}
\`\`\`

### Delta Feed (\`GET /v1/changes?since={iso_ts}\`)
Returns API/SDK deprecations and schema mutations since the agent's last run.
Add \`&scope=mine\` with your \`Authorization: Bearer <KEY>\` header to receive only changes for services in your dependency manifest (401 without a valid key).
Every change object in the feed (public and \`scope=mine\`) includes \`playbook_url\` — the URL of its generated migration playbook.

### Migration Playbooks (\`GET /v1/changes/{id}/playbook\`)
A breaking change tells you *what* broke; its playbook tells you *what to do*, step by step, in machine-readable form:
\`\`\`bash
curl "${origin}/v1/changes/{change_id}/playbook"
\`\`\`
\`\`\`json
{
  "playbook": {
    "change_id": "bc_...",
    "service": "stripe",
    "kind": "parameter_now_required",
    "summary": "Parameter 'account' (in: query) on GET /v1/charges is now required.",
    "steps": [
      { "action": "review_provider_hint", "detail": "Provider migration hint recorded with this change: ..." },
      { "action": "find_call_sites", "detail": "Find every call to GET /v1/charges that does not send the 'account' parameter..." },
      { "action": "add_parameter", "detail": "Always send 'account' when calling GET /v1/charges...",
        "code_example": { "before": "const res = await fetch(API_BASE + '/v1/charges', {\n});", "after": "const res = await fetch(API_BASE + '/v1/charges' + '?account=\${encodeURIComponent(accountValue)}', {\n});" } },
      { "action": "update_tests", "detail": "Update mocks/fixtures and add a regression test..." }
    ],
    "effort_estimate": "low",
    "risk_notes": ["Calls missing 'account' will start failing with validation errors..."]
  }
}
\`\`\`
- \`kind\` is the fine-grained spec-diff kind for \`schema_diff\` changes (\`removed_operation\`, \`removed_path\`, \`removed_parameter\`, \`parameter_now_required\`, \`new_required_parameter\`, \`parameter_type_changed\`, \`removed_request_property\`, \`request_property_now_required\`, \`new_required_request_property\`, \`request_property_type_changed\`, \`removed_response_property\`, \`response_property_type_changed\`, \`removed_response\`), recovered from the recorded diff summary; other changes classify by their stored \`change_type\` (\`deprecation\`, \`rate_limit_change\`, generic \`schema_change\` / \`breaking_change\` fallbacks).
- Steps are ordered: provider hint first, then find → fix → fallback (where relevant) → test. \`code_example\` (\`{ before, after }\`) appears on the steps where a mechanical edit exists.
- Examples are generic fetch-style templates built **only** from the change's own fields (operation, path, parameter/property name, old/new types). Replacement endpoints and parameter semantics are never invented — the playbook defers to the provider hint/changelog for those.
- Public read (no API key, no quota), cacheable. Unknown change id → \`404\`.

### JavaScript SDK (\`agentpulse-sdk\`)
For agents that prefer plain functions over MCP or raw HTTP: a zero-dependency client (global \`fetch\` only, Node 18+) in the \`sdk/\` directory of the AgentPulse repo.
\`\`\`js
import { AgentPulseClient, AgentPulseError } from 'agentpulse-sdk';
const client = new AgentPulseClient({ baseUrl: '${origin}', apiKey: 'agp_live_...' });
const status = await client.getStatus('stripe');            // ETag-cached; 304 returns the cached body
const verdict = await client.preflight(['stripe', 'openai']);
const impact = await client.getMyImpact();                  // manifest verdicts (via MCP get_my_impact)
const feed = await client.getChanges({ scope: 'mine' });    // changes carry playbook_url
const playbook = await client.getPlaybook(feed.changes[0].id);
await client.setDependencies([{ service: 'stripe', package: 'stripe', version: '14.5.0' }]);
await client.registerWebhook({ url: 'https://bots.example.com/agentpulse', services: ['stripe'] });
await client.reportOutage({ service: 'github', endpoint: 'POST /repos/o/r/pulls', error_code: 502 });
\`\`\`
Non-2xx responses throw \`AgentPulseError\` with \`.status\` and \`.body\`.

### Dependency Manifest & Affected Answers (\`PUT/GET /v1/agents/me/dependencies\`)
Register once, then declare the stack your code actually depends on:
\`\`\`bash
curl -X PUT "${origin}/v1/agents/me/dependencies" \\
  -H "Authorization: Bearer <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"dependencies": [{"service": "stripe", "package": "stripe", "version": "14.5.0"}, {"service": "openai"}]}'
\`\`\`
PUT is replace-all; slugs are validated against the monitored catalog (unknown slug → 400 naming the slug). \`GET\` on the same path returns the stored manifest.

With a manifest in place:
- \`POST /v1/preflight\` (authenticated) adds \`impact: { affected, incident_ids, change_ids, reason }\` to each requested service that is in your manifest, plus a top-level \`affected_count\`.
- \`GET /v1/changes?scope=mine\` filters the delta feed to your services.
- The MCP tool \`get_my_impact\` returns the verdict for your whole manifest in one call.

A dependency is **affected** when its service has any active incident, or any breaking change detected in the last 90 days.

### Webhook Alerts (\`POST/GET/DELETE /v1/agents/me/webhooks\`)
Stop polling: subscribe a URL and get pushed alerts for incidents and breaking changes.
\`\`\`bash
curl -X POST "${origin}/v1/agents/me/webhooks" \\
  -H "Authorization: Bearer <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://bots.example.com/agentpulse", "events": ["incident.created", "incident.resolved", "change.detected"], "services": ["stripe", "openai"]}'
\`\`\`
- \`events\` defaults to all three types. \`services\` is an explicit slug filter (validated; unknown slug → 400); omit it or pass null to receive all services. Tip: set \`services\` to the services in your dependency manifest to get only alerts for your stack — the filter is NOT intersected with your manifest automatically.
- The URL must be \`https://\`; \`http://\` is accepted only for \`localhost\` / \`127.0.0.1\` (local development).
- The \`201\` response contains the webhook \`secret\` (\`whsec_...\`) — **shown only once**, never returned by list/get calls again. Store it.
- Management calls (create/list/delete/delivery log) require your API key and count toward your daily quota, like the manifest endpoints.

Delivery format — a POST to your URL with \`Content-Type: application/json\`:
\`\`\`json
{
  "id": "whd_1a2b3c4d5e6f",
  "type": "incident.created",
  "created_at": "2026-11-21T22:30:00.000Z",
  "data": { "id": "inc_...", "service_slug": "stripe", "severity": "major", "affected_scope": "...", "agent_summary": "...", "agent_hint": "...", "started_at": "...", "resolved_at": null }
}
\`\`\`
\`data\` is the incident row for \`incident.*\` events and the breaking-change row for \`change.detected\`. Headers on every delivery:
- \`X-AgentPulse-Event\`: the event type (same as \`type\` in the body).
- \`X-AgentPulse-Delivery\`: the delivery id (same as \`id\` in the body).
- \`X-AgentPulse-Signature\`: \`sha256=<hex>\` — HMAC-SHA256 of the **raw request body**, keyed with your webhook secret.

Verify before acting on a payload:
\`\`\`js
import crypto from 'node:crypto';
const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody, 'utf8').digest('hex');
crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-agentpulse-signature']));
\`\`\`

Delivery policy: respond with any 2xx within 5 seconds. Failures (non-2xx, timeout, network error) are retried up to 3 total attempts with backoff (default delays 1s, 5s; configurable via \`WEBHOOK_RETRY_DELAYS_MS\`). Every attempt outcome is recorded — inspect it with \`GET /v1/agents/me/webhooks/{id}/deliveries\` (most recent 20). Deleting a webhook stops future deliveries and removes its log.

### Crowdsourced Telemetry (\`POST /v1/telemetry/report\`)
Report observed failures so the oracle detects outages early:
\`\`\`bash
curl -X POST "${origin}/v1/telemetry/report" \\
  -H "Authorization: Bearer <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"service": "github", "endpoint": "POST /repos/owner/repo/pulls", "error_code": 502, "error_type": "502_bad_gateway"}'
\`\`\`
Returns \`202\` on acceptance. An API key is required (401 anonymously) and each report counts toward your daily quota.

## 4. MCP (Model Context Protocol) Setup
Add AgentPulse to your agent's MCP configuration:

\`\`\`json
{
  "mcpServers": {
    "agentpulse": {
      "url": "${origin}/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_AGENTPULSE_KEY>"
      }
    }
  }
}
\`\`\`

Stateless Edge Invocation:
HTTP POST to \`${origin}/mcp\` with headers:
- \`Mcp-Method: tools/call\`
- \`Mcp-Name: check_dependency_health\`
- Body: \`{"dependencies": ["stripe", "openai"]}\`
`;
}
