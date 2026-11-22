# Installing AgentPulse in Cline

AgentPulse is a **hosted (remote) MCP server**. There is nothing to clone, build, or run locally — Cline connects to the live endpoint over Streamable HTTP.

- **MCP endpoint:** `https://agentpulse-43di.onrender.com/mcp`
- **Transport:** Streamable HTTP
- **Authentication:** Not required for the public tools. An optional free API key unlocks the identified tools and a higher quota.

## Setup (cline_mcp_settings.json)

Add this entry to `mcpServers` in Cline's MCP settings:

```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse-43di.onrender.com/mcp",
      "transportType": "streamableHttp",
      "disabled": false,
      "autoApprove": [
        "check_dependency_health",
        "lookup_breaking_changes",
        "get_service_status"
      ]
    }
  }
}
```

Then reload MCP servers in Cline. No environment variables, API keys, or local processes are needed for the public tools.

## Optional: free API key (identified tools + higher quota)

Two tools act on a registered agent identity, and registered agents get a higher daily quota:

1. Register (zero-CAPTCHA, programmatic):
   `POST https://agentpulse-43di.onrender.com/v1/agents/register`
   with a JSON body such as `{"name": "my-agent"}` — the response contains an `agp_live_...` API key.
2. Add the key to the server config:

```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse-43di.onrender.com/mcp",
      "transportType": "streamableHttp",
      "headers": {
        "Authorization": "Bearer <your agp_live_... key>"
      },
      "disabled": false
    }
  }
}
```

## Tools

| Tool | Auth | What it does |
| :--- | :--- | :--- |
| `check_dependency_health` | Public | Preflight health check across a list of services (e.g. `["stripe", "openai"]`): status, active incidents, and an agent hint per dependency. |
| `lookup_breaking_changes` | Public | Recent deprecations, schema diffs, and breaking changes for a service, with migration playbooks. |
| `get_service_status` | Public | Real-time health, active incidents, affected scope, and a prescriptive `agent_hint` for one service. |
| `get_my_impact` | API key | "Am I affected?" verdicts against your stored dependency manifest. |
| `report_outage_signal` | API key | Report an observed 5xx spike / timeout anomaly to crowdsource early outage detection. |

## Verify the install

Ask Cline: *"Use AgentPulse `get_service_status` for stripe."* A JSON verdict with `status`, `active_incidents`, and `recent_breaking_changes` confirms the connection.

## Notes

- Free tier: 100 counted requests/day per agent; ETag/`If-None-Match` revalidation responses (304) are free under the Good Citizen Protocol.
- Full docs: https://agentpulse-43di.onrender.com/llms.txt · OpenAPI: https://agentpulse-43di.onrender.com/openapi.json
- Source & self-hosting (Docker): https://github.com/Akshat-Srivastava-PS/AgentPulse
