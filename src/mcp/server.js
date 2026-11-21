import { evaluatePreflight } from '../engine/diffEngine.js';
import { getService, getActiveIncidents, getBreakingChanges, recordOutageSignal } from '../db/index.js';
import { formatCompactStatusPayload } from '../engine/normalizer.js';

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
    name: 'report_outage_signal',
    description: 'Submit an observed 5xx error spike, timeout, or rate-limit anomaly to crowdsource early outage detection across the agent ecosystem.',
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

export async function executeMcpTool(name, args = {}) {
  switch (name) {
    case 'check_dependency_health': {
      const dependencies = args.dependencies || [];
      const result = evaluatePreflight(dependencies);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
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
      const recorded = recordOutageSignal({
        service_slug: service,
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
      const result = await executeMcpTool(toolName, toolArgs);
      return {
        status: 200,
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
    try {
      const result = await executeMcpTool(name, toolArgs || {});
      return {
        status: 200,
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
