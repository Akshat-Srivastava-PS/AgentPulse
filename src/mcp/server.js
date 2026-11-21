import { evaluatePreflight, evaluateManifestImpact } from '../engine/diffEngine.js';
import { getService, getActiveIncidents, getBreakingChanges, recordOutageSignal, getAgentByApiKey, recordAgentUsage, getAgentQuotaState } from '../db/index.js';
import { formatCompactStatusPayload } from '../engine/normalizer.js';
import { getRequestLogContext } from '../engine/requestContext.js';

/**
 * Resolves the calling agent's identity for manifest-aware tools.
 * Primary: the same `Authorization: Bearer agp_live_...` header the REST
 * layer uses (and the documented MCP client config sends). Fallback: an
 * explicit `api_key` tool argument, for header-routed clients that cannot
 * set headers. Returns null when no valid key is presented.
 */
export function resolveMcpAgent(req, args = {}) {
  const authHeader = req?.headers?.['authorization'];
  if (authHeader) {
    const parts = String(authHeader).split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      const agent = getAgentByApiKey(parts[1]);
      if (agent) return agent;
    }
  }
  if (args && typeof args.api_key === 'string' && args.api_key.trim() !== '') {
    return getAgentByApiKey(args.api_key);
  }
  return null;
}

// --- Step 3: quota enforcement for identified MCP callers ---
// Anonymous tool calls stay open (public read surface, same policy as REST).
// An identified agent's tool calls count toward its daily quota; once the
// quota is exhausted, tools/call is rejected before execution.

function mcpRateLimitHeaders(agent) {
  const state = getAgentQuotaState(agent.id);
  if (!state) return {};
  return {
    'X-RateLimit-Limit': String(state.limit),
    'X-RateLimit-Remaining': String(state.remaining),
    'X-RateLimit-Reset': String(state.reset_epoch_seconds)
  };
}

function quotaGateForToolCall(req, args) {
  const agent = resolveMcpAgent(req, args);
  if (!agent) return { agent: null, headers: {} };
  // Owner visibility: attribute the in-flight request to this agent (the
  // api_key-argument path resolves identity only here, not in the HTTP
  // layer). recordAgentUsage below flags the request as counted.
  const logCtx = getRequestLogContext();
  if (logCtx) {
    logCtx.agentId = agent.id;
    logCtx.agentName = agent.agent_name;
  }
  const state = getAgentQuotaState(agent.id);
  if (state && !state.allowed) {
    return { agent, exceeded: state, headers: {} };
  }
  recordAgentUsage(agent.id, false);
  return { agent, headers: mcpRateLimitHeaders(agent) };
}

function rateLimitMessage(state) {
  return `Rate limit exceeded: daily quota of ${state.limit} requests exhausted. Quota resets at ${state.reset_at} (UTC midnight).`;
}

export const MCP_TOOLS = [
  {
    name: 'check_dependency_health',
    description: 'Preflight dependency health check for AI coding & devops agents. Evaluates if third-party APIs or cloud providers are experiencing outages, rate-limit spikes, or silent failures before wasting tokens retrying failing calls.',
    inputSchema: {
      type: 'object',
      properties: {
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of service slugs to check (e.g. ["stripe", "openai", "supabase", "resend", "aws", "github"])'
        }
      },
      required: ['dependencies']
    }
  },
  {
    name: 'lookup_breaking_changes',
    description: 'Query recent API deprecations, schema diffs, and breaking changes for a cloud service or package before invoking SDKs.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service slug (e.g. "openai", "stripe", "supabase", "aws")'
        },
        since: {
          type: 'string',
          description: 'Optional ISO 8601 timestamp checkpoint (e.g. "2026-01-01T00:00:00Z")'
        }
      },
      required: ['service']
    }
  },
  {
    name: 'get_service_status',
    description: 'Retrieve real-time health, active incidents, affected scope, and prescriptive agent_hint for a single cloud provider or API in < 150 tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service slug (e.g. "stripe", "openai", "anthropic", "github", "aws")'
        }
      },
      required: ['service']
    }
  },
  {
    name: 'get_my_impact',
    description: 'Returns "affected code" verdicts for the calling agent\'s stored dependency manifest (set via PUT /v1/agents/me/dependencies): for each dependency, whether an active incident or a breaking change detected in the last 90 days affects it, with matching incident/change ids and a one-line reason. Identity comes from the Authorization: Bearer <api_key> header (same as REST); an api_key argument is accepted as a fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: {
          type: 'string',
          description: 'Optional AgentPulse API key (agp_live_...). Only needed when the Authorization header is not sent.'
        }
      },
      required: []
    }
  },
  {
    name: 'report_outage_signal',
    description: 'Submit an observed 5xx error spike, timeout, or rate-limit anomaly to crowdsource early outage detection across the agent ecosystem. Requires the calling agent\'s API key (Authorization: Bearer header or api_key argument) — anonymous signals are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service slug where failure was observed' },
        endpoint: { type: 'string', description: 'Affected HTTP endpoint or method (e.g. POST /v1/chat/completions)' },
        error_code: { type: 'integer', description: 'HTTP status code observed (e.g. 500, 502, 503, 504, 429)' },
        error_type: { type: 'string', description: 'Optional error description or category' }
      },
      required: ['service', 'endpoint', 'error_code']
    }
  }
];

export async function executeMcpTool(name, args = {}, context = {}) {
  // Agent identity (manifest-aware tools): context.agent is resolved by the
  // transport from the Authorization header; fall back to an api_key argument.
  const callerAgent = context.agent || null;
  const resolveAgent = () => callerAgent || (args && typeof args.api_key === 'string' ? getAgentByApiKey(args.api_key) : null);

  switch (name) {
    case 'check_dependency_health': {
      const dependencies = args.dependencies || [];
      const agent = resolveAgent();
      const result = evaluatePreflight(dependencies, agent ? agent.id : null);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }

    case 'get_my_impact': {
      const agent = resolveAgent();
      if (!agent) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Unauthorized: get_my_impact requires your AgentPulse API key — send it as the Authorization: Bearer header (as in the documented MCP config) or as the api_key argument. Register at POST /v1/agents/register, then set your manifest via PUT /v1/agents/me/dependencies.'
              })
            }
          ]
        };
      }

      const impact = evaluateManifestImpact(agent.id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              agent_id: agent.id,
              agent_name: agent.agent_name,
              ...impact
            }, null, 2)
          }
        ]
      };
    }

    case 'lookup_breaking_changes': {
      const serviceSlug = (args.service || '').toLowerCase().trim();
      const since = args.since || null;
      const changes = getBreakingChanges(serviceSlug || null, since);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              service: serviceSlug || 'all',
              count: changes.length,
              breaking_changes: changes
            }, null, 2)
          }
        ]
      };
    }

    case 'get_service_status': {
      const serviceSlug = (args.service || '').toLowerCase().trim();
      const service = getService(serviceSlug);
      if (!service) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Service '${serviceSlug}' not found. Use check_dependency_health with supported services (stripe, openai, anthropic, github, aws, supabase, vercel, cloudflare, resend, etc.)`
              })
            }
          ]
        };
      }

      const activeIncidents = getActiveIncidents(serviceSlug);
      const recentThreshold = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const breaking = getBreakingChanges(serviceSlug, recentThreshold);
      const compact = formatCompactStatusPayload(service, activeIncidents, breaking);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(compact, null, 2)
          }
        ]
      };
    }

    case 'report_outage_signal': {
      const { service, endpoint, error_code, error_type } = args;
      const agent = resolveAgent();
      if (!agent) {
        // Step 3: writes must be attributable — anonymous signals are rejected.
        // Identified callers (Authorization header or api_key argument) are
        // unaffected; this is the same identity path as get_my_impact.
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Unauthorized: report_outage_signal requires your AgentPulse API key — send it as the Authorization: Bearer header (as in the documented MCP config) or as the api_key argument. Register at POST /v1/agents/register.'
              })
            }
          ]
        };
      }
      const recorded = recordOutageSignal({
        service_slug: service,
        agent_id: agent.id,
        endpoint,
        error_code,
        error_type
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'recorded',
              signal_id: recorded.id,
              message: 'Outage signal logged. Normalizer engine updated.'
            }, null, 2)
          }
        ]
      };
    }

    default:
      throw new Error(`Unknown MCP Tool: '${name}'`);
  }
}

/**
 * Handles incoming stateless HTTP MCP requests
 * Supports both JSON-RPC 2.0 and HTTP header-based routing (Mcp-Method / Mcp-Name)
 */
export async function handleMcpRequest(req, body = {}) {
  // Check header-based routing first
  const headerMethod = req.headers['mcp-method'];
  const headerName = req.headers['mcp-name'];

  if (headerMethod) {
    if (headerMethod === 'tools/list') {
      return {
        status: 200,
        body: { tools: MCP_TOOLS }
      };
    }
    if (headerMethod === 'tools/call' || headerMethod === 'execute') {
      const toolName = headerName || body.name;
      const toolArgs = body.arguments || body.args || body;
      const gate = quotaGateForToolCall(req, toolArgs);
      if (gate.exceeded) {
        return {
          status: 429,
          headers: {
            'Retry-After': String(gate.exceeded.retry_after_seconds),
            'X-RateLimit-Limit': String(gate.exceeded.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(gate.exceeded.reset_epoch_seconds)
          },
          body: {
            error: rateLimitMessage(gate.exceeded),
            rate_limit: {
              limit: gate.exceeded.limit,
              used: gate.exceeded.used,
              remaining: 0,
              reset_at: gate.exceeded.reset_at
            }
          }
        };
      }
      const result = await executeMcpTool(toolName, toolArgs, { agent: gate.agent });
      return {
        status: 200,
        headers: gate.headers,
        body: result
      };
    }
  }

  // Standard JSON-RPC 2.0 payload handling
  const { jsonrpc, id, method, params } = body;

  if (method === 'initialize') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: 'agentpulse-oracle',
            version: '1.0.0',
            description: 'Live API & Cloud Status / Breaking-Change Oracle for AI Agents'
          }
        }
      }
    };
  }

  if (method === 'ping') {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: {} }
    };
  }

  if (method === 'tools/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          tools: MCP_TOOLS
        }
      }
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    const gate = quotaGateForToolCall(req, toolArgs || {});
    if (gate.exceeded) {
      return {
        status: 429,
        headers: {
          'Retry-After': String(gate.exceeded.retry_after_seconds),
          'X-RateLimit-Limit': String(gate.exceeded.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(gate.exceeded.reset_epoch_seconds)
        },
        body: {
          jsonrpc: '2.0',
          id: id || 1,
          error: {
            code: -32029,
            message: rateLimitMessage(gate.exceeded),
            data: {
              rate_limit: {
                limit: gate.exceeded.limit,
                used: gate.exceeded.used,
                remaining: 0,
                reset_at: gate.exceeded.reset_at
              }
            }
          }
        }
      };
    }
    try {
      const result = await executeMcpTool(name, toolArgs || {}, { agent: gate.agent });
      return {
        status: 200,
        headers: gate.headers,
        body: {
          jsonrpc: '2.0',
          id: id || 1,
          result
        }
      };
    } catch (err) {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id || 1,
          error: {
            code: -32602,
            message: err.message
          }
        }
      };
    }
  }

  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: id || null,
      error: {
        code: -32601,
        message: `Method not found: '${method}'`
      }
    }
  };
}
