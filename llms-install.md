# Installing AgentPulse in Cline & MCP Clients

AgentPulse is a **hosted (remote) MCP server**. There is nothing to clone, build, or run locally — MCP clients connect directly to the live endpoint over Streamable HTTP.

- **MCP endpoint:** `https://agentpulse-43di.onrender.com/mcp`
- **Transport:** Streamable HTTP
- **Authentication:** Not required for public tools. An optional free API key unlocks identified tools and higher quota.

---

## 1. Quick Setup (Public Tools)

### Cline (`cline_mcp_settings.json`)
Add this entry to `mcpServers` in Cline's settings:

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

### Cursor / Claude Desktop / Windsurf
For clients using standard MCP JSON configs:

```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse-43di.onrender.com/mcp",
      "transportType": "streamableHttp"
    }
  }
}
```

Reload MCP servers in your client. No API keys, environment variables, or local processes are needed for the public tools.

---

## 2. Optional: Free API Key (Identified Tools + Manifest Impact)

Two tools act on a registered agent identity (`get_my_impact`, `report_outage_signal`), and registered agents get a higher quota allocation.

### Step 1: Programmatic Registration (Zero-CAPTCHA)
Register via `POST /v1/agents/register` with `agent_name` and `operator_url`:

```bash
curl -X POST https://agentpulse-43di.onrender.com/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "my-coding-bot",
    "operator_url": "https://github.com/myorg/my-bot"
  }'
```

**Response (`201 Created`):**
```json
{
  "message": "Agent registered successfully. Zero-CAPTCHA verification complete.",
  "agent": {
    "id": "agent_abc12345",
    "agent_name": "my-coding-bot",
    "operator_url": "https://github.com/myorg/my-bot",
    "tier": "free_verified",
    "daily_quota": 100,
    "good_citizen_score": 100,
    "api_key": "agp_live_0123456789abcdef..."
  }
}
```
*Note: Store your `api_key` securely; it is shown only once upon registration.*

### Step 2: Add API Key to MCP Config
Add the `Authorization` header and include all 5 tools in `autoApprove`:

```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse-43di.onrender.com/mcp",
      "transportType": "streamableHttp",
      "headers": {
        "Authorization": "Bearer agp_live_0123456789abcdef..."
      },
      "disabled": false,
      "autoApprove": [
        "check_dependency_health",
        "lookup_breaking_changes",
        "get_service_status",
        "get_my_impact",
        "report_outage_signal"
      ]
    }
  }
}
```

---

## 3. Available MCP Tools

| Tool | Access | Description |
| :--- | :--- | :--- |
| `check_dependency_health` | Public | Preflight batch health check across services (e.g. `["stripe", "openai"]`): status, active incidents, and prescriptive `agent_hint` per dependency. |
| `lookup_breaking_changes` | Public | Query recent deprecations, schema mutations, and migration playbooks for a service. |
| `get_service_status` | Public | Real-time health, active incidents, affected scope, and agent hint for a single service in < 150 tokens. |
| `get_my_impact` | API Key | "Am I affected?" verdicts evaluated against your stored dependency manifest. |
| `report_outage_signal` | API Key | Crowdsource 5xx error spikes and runtime timeouts to trigger proactive early outage detection. |

---

## 4. Verify Installation

In Cline or your agent chat, run:
> *"Use AgentPulse `get_service_status` for stripe."*

A compact JSON verdict with `status`, `active_incidents`, and `recent_breaking_changes` confirms the connection.

---

## 5. Notes & Reference

- **Good Citizen Protocol**: Conditional requests (`If-None-Match` returning `304 Not Modified`) cost 0 tokens and **do not consume daily quota**.
- **Full Documentation**: [https://agentpulse-43di.onrender.com/llms.txt](https://agentpulse-43di.onrender.com/llms.txt) · [llms-full.txt](https://agentpulse-43di.onrender.com/llms-full.txt)
- **OpenAPI Schema**: [https://agentpulse-43di.onrender.com/openapi.json](https://agentpulse-43di.onrender.com/openapi.json)
- **GitHub Repository**: [https://github.com/Akshat-Srivastava-PS/AgentPulse](https://github.com/Akshat-Srivastava-PS/AgentPulse)
