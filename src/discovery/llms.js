/**
 * LLMS.txt and LLMS-Full.txt generators adhering to the https://llmstxt.org specification
 */

export function generateLlmsTxt(origin = 'https://agentpulse.dev') {
  return `# AgentPulse

> Real-time ground-truth hub and breaking-change oracle for autonomous AI agents, coding assistants (Claude Code, Cursor, Cline), and CI bots. Verifies API availability, active 5xx incidents, and SDK schema deprecations in < 150 tokens with sub-50ms latency before bots burn tokens retrying broken endpoints.

## Core API & Discovery
- [OpenAPI 3.1 Specification](${origin}/openapi.json): Strict machine-readable API definitions for autonomous tool calling.
- [Full Agent Context Documentation](${origin}/llms-full.txt): Complete operational guide, payload schemas, and client retry policies.
- [Self-Serve Bot Onboarding](${origin}/v1/agents/register): Zero-CAPTCHA programmatic API key issuance (1,000 requests/day free tier).

## Essential Preflight & Status Tools
- [Batch Preflight Check](${origin}/v1/preflight): POST dependency list (e.g. ["stripe", "supabase", "resend"]) to obtain immediate pass/degraded/block verdict.
- [Service Status Query](${origin}/v1/status/stripe): GET compact health status, active incidents, affected scope, and prescriptive agent_hint (< 150 tokens).
- [Delta Feed of Breaking Changes](${origin}/v1/changes): GET recent SDK deprecations and schema mutations since timestamp checkpoint. Add \`?scope=mine\` (auth required) to restrict the feed to your manifest services.
- [All Monitored Services](${origin}/v1/services): Full catalog of tracked cloud providers, APIs, and registries.
- [Live Incident Feed](${origin}/v1/incidents): Active incidents with severity ratings and mitigation hints.

## My Dependency Manifest & Affected Answers (Auth Required)
- [Dependency Manifest](${origin}/v1/agents/me/dependencies): \`PUT\` replaces your stored manifest: \`{"dependencies": [{"service": "stripe", "package": "stripe", "version": "14.5.0"}]}\` (package/version optional; unknown slugs rejected with 400). \`GET\` returns it. Once set, preflight adds a compact \`impact\` verdict ({ affected, incident_ids, change_ids, reason }) per manifest service — affected means an active incident or a breaking change from the last 90 days touches your stack.

## Stateless HTTP MCP Server
- [Stateless MCP Endpoint](${origin}/mcp): Streamable Model Context Protocol endpoint supporting both JSON-RPC 2.0 and Mcp-Method / Mcp-Name header routing. Send \`Authorization: Bearer <api_key>\` to identify your agent.
  - \`check_dependency_health\`: Mid-debugging stack health preflight (manifest-aware when authenticated).
  - \`lookup_breaking_changes\`: Deprecation and schema diff analyzer.
  - \`get_service_status\`: Instant single-service health check.
  - \`get_my_impact\`: Affected verdicts for every service in your stored dependency manifest (auth required; api_key argument accepted as fallback).
  - \`report_outage_signal\`: Crowdsource early 5xx anomaly detection.

## Good Citizen Protocol
- **ETag & 304 Not Modified**: Always pass \`If-None-Match: <etag>\` in subsequent requests. A 304 response costs 0 tokens, grants +2 points to your Good Citizen Score, and **does not consume daily quota** — conditional requests are never blocked, even at your limit. Score upgrades automatically expand your daily quota (1,000 → 2,500 → 5,000 req/day).

## Quotas & Auth (Enforced)
- **Daily quota**: free tier 1,000 counted requests/day, resetting at UTC midnight. Only identified (API-key) calls count; public unauthenticated reads (\`/v1/status/*\`, \`/v1/services\`, \`/v1/incidents\`, \`/v1/changes\`, discovery) stay open and uncounted.
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
  Response: \`{"api_key": "agp_live_...", "tier": "free_verified", "daily_quota": 1000, "good_citizen_score": 100}\`

- **Header Authentication**:
  Pass \`Authorization: Bearer agp_live_...\` with all queries.

- **Good Citizen Protocol (ETag 304 Caching)**:
  Every status response includes a strong/weak \`ETag\` header (e.g. \`W/"a1b2c3d4e5f6"\`).
  When querying \`GET /v1/status/{service}\`, bots should supply \`If-None-Match: W/"a1b2c3d4e5f6"\`.
  If the service state has not mutated:
  - Server returns \`HTTP 304 Not Modified\` with an empty body (0 tokens consumed!).
  - The 304 **does not count toward your daily quota** and is served even when the quota is exhausted.
  - Bot receives \`+2\` to its \`good_citizen_score\`.
  - Hitting a score of 300 upgrades quota to 2,500 req/day; score of 600 upgrades to 5,000 req/day.

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

Response:
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
Compact (< 150 token) response:
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
