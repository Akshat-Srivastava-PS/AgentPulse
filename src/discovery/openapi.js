export function generateOpenApiSchema(origin = 'https://agentpulse.dev') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentPulse API & Cloud Status Oracle',
      version: '1.0.0',
      description: 'Real-time ground-truth hub and breaking-change oracle for coding and operational AI agents. Returns token-compact (< 150 tokens) health statuses, ETag-cached 304 responses, and deterministic dependency preflight checks.'
    },
    servers: [
      {
        url: origin,
        description: 'AgentPulse Edge Server'
      }
    ],
    paths: {
      '/llms.txt': {
        get: {
          summary: 'Agent Discovery Map',
          description: 'Plain-text Markdown map of capabilities, rate limits, and tool endpoints formatted to the llms.txt standard.',
          responses: {
            '200': {
              description: 'Discovery map markdown',
              content: { 'text/plain': { schema: { type: 'string' } } }
            }
          }
        }
      },
      '/v1/agents/register': {
        post: {
          summary: 'Zero-CAPTCHA Self-Serve Agent Onboarding',
          description: 'Registers an autonomous AI agent or bot and instantly issues a free-tier API key (1,000 req/day).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agent_name: { type: 'string', example: 'Cursor-Assistant-v2' },
                    operator_url: { type: 'string', format: 'uri', example: 'https://github.com/myorg/autonomous-bot' }
                  },
                  required: ['agent_name', 'operator_url']
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Agent successfully registered with API key',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      api_key: { type: 'string', example: 'agp_live_9a8b7c6d5e4f3a2b1c' },
                      agent_name: { type: 'string' },
                      operator_url: { type: 'string' },
                      tier: { type: 'string', example: 'free_verified' },
                      daily_quota: { type: 'integer', example: 1000 },
                      good_citizen_score: { type: 'integer', example: 100 }
                    }
                  }
                }
              }
            },
            '400': { description: 'Missing agent_name or invalid operator_url' }
          }
        }
      },
      '/v1/status/{service}': {
        get: {
          summary: 'Single Service Status & Incident Query',
          description: 'Returns current health, active incidents, affected regions/scope, and recommended fallback action in < 150 tokens. Supports If-None-Match (304 Not Modified).',
          parameters: [
            {
              name: 'service',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'stripe' },
              description: 'Service slug (e.g. stripe, openai, aws, supabase, github, vercel)'
            },
            {
              name: 'If-None-Match',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'ETag from previous response. Returns 304 if state has not mutated.'
            }
          ],
          responses: {
            '200': {
              description: 'Compact service health payload (< 150 tokens)',
              headers: {
                ETag: { schema: { type: 'string', example: 'W/"9821a8b7"' } },
                'X-Good-Citizen-Score': { schema: { type: 'integer', example: 142 } }
              },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      service: { type: 'string' },
                      status: { type: 'string', enum: ['operational', 'degraded', 'outage'] },
                      updated_at: { type: 'string', format: 'date-time' },
                      active_incidents: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
                            scope: { type: 'string' },
                            summary: { type: 'string' },
                            agent_hint: { type: 'string' }
                          }
                        }
                      },
                      recent_breaking_changes: { type: 'array', items: { type: 'object' } }
                    }
                  }
                }
              }
            },
            '304': { description: 'Not Modified. Service state unchanged since provided ETag.' },
            '404': { description: 'Service not found in registry.' }
          }
        }
      },
      '/v1/preflight': {
        post: {
          summary: 'Batch Dependency Preflight Check',
          description: 'Agent sends an array of dependencies before running a toolchain or workflow; receives a single pass/degraded/block verdict.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dependencies: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['stripe', 'supabase', 'resend']
                    }
                  },
                  required: ['dependencies']
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Batch preflight verdict and per-service breakdown',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      verdict: { type: 'string', enum: ['pass', 'degraded', 'block'] },
                      healthy: { type: 'boolean' },
                      checked_at: { type: 'string', format: 'date-time' },
                      total_requested: { type: 'integer' },
                      outage_count: { type: 'integer' },
                      degraded_count: { type: 'integer' },
                      recommendation: { type: 'string' },
                      services: { type: 'object' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/v1/changes': {
        get: {
          summary: 'Delta Feed of Breaking Changes & Deprecations',
          description: 'Returns API, SDK, and schema deprecations detected since an ISO 8601 timestamp checkpoint.',
          parameters: [
            {
              name: 'since',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'ISO 8601 checkpoint timestamp'
            },
            {
              name: 'service',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Optional service slug filter'
            }
          ],
          responses: {
            '200': {
              description: 'List of breaking changes matching criteria',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      since: { type: 'string' },
                      changes: { type: 'array', items: { type: 'object' } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/v1/services': {
        get: {
          summary: 'List All Monitored Services',
          description: 'Returns full list of services, categories, latency, uptime, and current health status.',
          responses: {
            '200': {
              description: 'List of tracked services',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      services: { type: 'array', items: { type: 'object' } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/v1/incidents': {
        get: {
          summary: 'List Incidents',
          description: 'Returns active and recent historical incidents across cloud providers.',
          parameters: [
            {
              name: 'active_only',
              in: 'query',
              required: false,
              schema: { type: 'boolean', default: true }
            }
          ],
          responses: {
            '200': {
              description: 'List of incidents',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      incidents: { type: 'array', items: { type: 'object' } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/v1/stream': {
        get: {
          summary: 'Server-Sent Events (SSE) Live Feed',
          description: 'Real-time event stream broadcasting status updates, new incidents, resolutions, and probe updates.',
          responses: {
            '200': {
              description: 'SSE stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } }
            }
          }
        }
      },
      '/mcp': {
        post: {
          summary: 'Stateless Streamable HTTP MCP Server',
          description: 'Model Context Protocol endpoint supporting check_dependency_health, lookup_breaking_changes, get_service_status, and report_outage_signal via JSON-RPC 2.0 or Mcp-Method/Mcp-Name headers.',
          responses: {
            '200': { description: 'MCP JSON-RPC response or streamable tool output' }
          }
        }
      }
    }
  };
}
