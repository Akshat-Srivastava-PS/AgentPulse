# agentpulse

A thin, **zero-dependency** JavaScript client for [AgentPulse](../README.md) — the live API & cloud status / breaking-change oracle for AI agents. It uses only the global `fetch` (Node 18+, modern browsers, edge runtimes) and wraps the REST API in plain functions, including the Good Citizen ETag/304 caching protocol.

> **MCP or SDK?** AgentPulse also ships a stateless HTTP MCP server at `/mcp` for agent frameworks that speak the Model Context Protocol natively. This SDK is the alternative for agents, scripts, and CI jobs that would rather call plain functions than wire up an MCP transport — same data, same API key. (One method, `getMyImpact()`, internally calls the MCP `get_my_impact` tool, because that is where the manifest-wide verdict lives.)

## Install

```bash
npm install @sriakshat/agentpulse
```

Or straight from this repo (no build step, ESM):

```js
import { AgentPulseClient } from './sdk/index.js';
```

## Quickstart

```js
import { AgentPulseClient, AgentPulseError } from '@sriakshat/agentpulse';

const client = new AgentPulseClient({
  baseUrl: 'https://agentpulse.dev',
  apiKey: process.env.AGENTPULSE_API_KEY // agp_live_... from POST /v1/agents/register
});

// 1. Is a dependency healthy right now? (< 150 tokens, ETag-cached)
const status = await client.getStatus('stripe');
console.log(status.status); // 'operational' | 'degraded' | 'outage'

// 2. Preflight a whole stack before running a workflow
const verdict = await client.preflight(['stripe', 'openai', 'supabase']);
if (verdict.verdict === 'block') throw new Error(verdict.recommendation);

// 3. Declare your stack once, then ask "am I affected?"
await client.setDependencies([
  { service: 'stripe', package: 'stripe', version: '14.5.0' },
  { service: 'openai' }
]);
const impact = await client.getMyImpact();
console.log(impact.affected_services); // e.g. ['stripe']

// 4. Breaking changes for your stack, each with a migration playbook
const feed = await client.getChanges({ scope: 'mine' });
for (const change of feed.changes) {
  const playbook = await client.getPlaybook(change.id);
  console.log(change.id, playbook.kind, playbook.effort_estimate, playbook.steps.length, 'steps');
}

// 5. Get pushed instead of polling
const { webhook } = await client.registerWebhook({
  url: 'https://bots.example.com/agentpulse',
  events: ['incident.created', 'incident.resolved', 'change.detected'],
  services: ['stripe', 'openai']
});
console.log('Store this secret (shown once):', webhook.secret);

// 6. Crowdsource an outage you observed
await client.reportOutage({ service: 'github', endpoint: 'POST /repos/o/r/pulls', error_code: 502 });
```

## API

| Method | Endpoint(s) | Auth |
| :--- | :--- | :--- |
| `getStatus(service)` | `GET /v1/status/{service}` | optional |
| `preflight(services)` | `POST /v1/preflight` | optional (manifest `impact` verdicts need a key) |
| `getChanges({ since, scope, service })` | `GET /v1/changes` | `scope: 'mine'` needs a key |
| `getPlaybook(changeId)` | `GET /v1/changes/{id}/playbook` | public |
| `getMyImpact()` | MCP `get_my_impact` via `POST /mcp` | required |
| `setDependencies(list)` | `PUT /v1/agents/me/dependencies` | required |
| `getDependencies()` | `GET /v1/agents/me/dependencies` | required |
| `registerWebhook(payload)` | `POST /v1/agents/me/webhooks` | required |
| `reportOutage(payload)` | `POST /v1/telemetry/report` | required |

### ETag caching

`getStatus()` stores each service's `ETag` in an in-memory cache (`client.statusCache`) and sends `If-None-Match` on repeat calls. When the server answers **304 Not Modified**, the cached body is returned — identical result, zero tokens, and 304s never consume your daily quota server-side. Call `client.clearStatusCache()` to reset.

### Errors

Every non-2xx response throws an `AgentPulseError` with `.status` (HTTP status) and `.body` (parsed JSON error body, including `rate_limit` details on 429):

```js
try {
  await client.getStatus('not-a-service');
} catch (err) {
  if (err instanceof AgentPulseError) {
    console.error(err.status, err.body.error); // 404, "Service 'not-a-service' not found..."
  }
}
```

## License

MIT
