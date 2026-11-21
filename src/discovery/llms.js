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
- [Delta Feed of Breaking Changes](${origin}/v1/changes): GET recent SDK deprecations and schema mutations since timestamp checkpoint.
- [All Monitored Services](${origin}/v1/services): Full catalog of tracked cloud providers, APIs, and registries.
- [Live Incident Feed](${origin}/v1/incidents): Active incidents with severity ratings and mitigation hints.

## Stateless HTTP MCP Server
- [Stateless MCP Endpoint](${origin}/mcp): Streamable Model Context Protocol endpoint supporting both JSON-RPC 2.0 and Mcp-Method / Mcp-Name header routing.
  - \`check_dependency_health\`: Mid-debugging stack health preflight.
  - \`lookup_breaking_changes\`: Deprecation and schema diff analyzer.
  - \`get_service_status\`: Instant single-service health check.
  - \`report_outage_signal\`: Crowdsource early 5xx anomaly detection.

## Good Citizen Protocol
- **ETag & 304 Not Modified**: Always pass \`If-None-Match: <etag>\` in subsequent requests. A 304 response costs 0 tokens and grants +2 points to your Good Citizen Score, automatically expanding your daily rate quota up to 5,000 req/day.
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
  - Bot receives \`+2\` to its \`good_citizen_score\`.
  - Hitting a score of 300 upgrades quota to 2,500 req/day; score of 600 upgrades to 5,000 req/day.

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
