// Step 3: shared rate-limit documentation fragments. Authenticated responses
// carry the X-RateLimit-* headers; an exhausted daily quota yields a 429
// with Retry-After (seconds to the UTC-midnight reset).
const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': { schema: { type: 'integer', example: 1000 }, description: 'Daily quota for the authenticated agent (1000 free tier; 2500 / 5000 with Good Citizen score upgrades).' },
  'X-RateLimit-Remaining': { schema: { type: 'integer', example: 999 }, description: 'Requests remaining in the current UTC day window.' },
  'X-RateLimit-Reset': { schema: { type: 'integer', example: 1767225600 }, description: 'Unix epoch seconds of the next quota reset (UTC midnight).' }
};

const RATE_LIMITED_RESPONSE = {
  description: 'Daily quota exhausted. Retry after the seconds given in the Retry-After header (reset at UTC midnight). Conditional requests answered 304 never consume quota.',
  headers: {
    'Retry-After': { schema: { type: 'integer', example: 3600 }, description: 'Seconds until the quota resets at UTC midnight.' },
    ...RATE_LIMIT_HEADERS
  },
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          rate_limit: {
            type: 'object',
            properties: {
              limit: { type: 'integer' },
              used: { type: 'integer' },
              remaining: { type: 'integer', example: 0 },
              reset_at: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  }
};

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
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'AgentPulse API key issued by POST /v1/agents/register (agp_live_...).'
        }
      }
    },
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
      '/v1/agents/me/dependencies': {
        get: {
          summary: 'Get My Dependency Manifest',
          description: 'Returns the authenticated agent\'s stored dependency manifest (services + optional package/version pins) used for "affected code" answers.',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'The caller\'s dependency manifest',
              headers: RATE_LIMIT_HEADERS,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agent_id: { type: 'string' },
                      count: { type: 'integer' },
                      dependencies: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            service: { type: 'string', example: 'stripe' },
                            package: { type: ['string', 'null'], example: 'stripe' },
                            version: { type: ['string', 'null'], example: '14.5.0' },
                            created_at: { type: 'string', format: 'date-time' },
                            updated_at: { type: 'string', format: 'date-time' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            '401': { description: 'Missing or invalid API key' },
            '429': RATE_LIMITED_RESPONSE
          }
        },
        put: {
          summary: 'Replace My Dependency Manifest',
          description: 'Replace-all update of the authenticated agent\'s dependency manifest. Service slugs are validated against the monitored catalog; an unknown slug rejects the whole update with 400. An empty array clears the manifest.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dependencies: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          service: { type: 'string', example: 'stripe' },
                          package: { type: 'string', example: 'stripe' },
                          version: { type: 'string', example: '14.5.0' }
                        },
                        required: ['service']
                      },
                      example: [
                        { service: 'stripe', package: 'stripe', version: '14.5.0' },
                        { service: 'openai' }
                      ]
                    }
                  },
                  required: ['dependencies']
                }
              }
            }
          },
          responses: {
            '200': { description: 'Manifest stored; returns the stored manifest', headers: RATE_LIMIT_HEADERS },
            '400': { description: 'Malformed body or unknown service slug (see unknown_service field)' },
            '401': { description: 'Missing or invalid API key' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/agents/me/webhooks': {
        post: {
          summary: 'Create a Webhook Subscription',
          description: 'Registers a webhook for incident and breaking-change alerts (Step 4). Events: `incident.created`, `incident.resolved`, `change.detected` (default: all). `services` optionally restricts delivery to those service slugs (omit/null = all services; set it to your manifest services to get only alerts for your stack). The URL must be https:// — http:// is accepted only for localhost / 127.0.0.1 for development. The response includes the webhook `secret` — shown ONLY in this create response — used to verify the `X-AgentPulse-Signature: sha256=<HMAC-SHA256 hex of the raw request body, keyed with the secret>` header sent with every delivery. Deliveries are POSTed JSON `{ id, type, created_at, data }` with `X-AgentPulse-Event` and `X-AgentPulse-Delivery` headers, a 5s timeout, and up to 3 attempts (backoff via WEBHOOK_RETRY_DELAYS_MS). Counts toward the daily quota.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', format: 'uri', example: 'https://bots.example.com/agentpulse' },
                    events: { type: 'array', items: { type: 'string', enum: ['incident.created', 'incident.resolved', 'change.detected'] }, example: ['incident.created', 'change.detected'] },
                    services: { type: 'array', items: { type: 'string' }, example: ['stripe', 'openai'], description: 'Service slug filter; omit or null for all services.' }
                  },
                  required: ['url']
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Webhook created; `secret` is present in this response only',
              headers: RATE_LIMIT_HEADERS,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                      webhook: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', example: 'wh_1a2b3c4d5e6f' },
                          agent_id: { type: 'string' },
                          url: { type: 'string' },
                          events: { type: 'array', items: { type: 'string' } },
                          services: { type: ['array', 'null'], items: { type: 'string' } },
                          secret: { type: 'string', example: 'whsec_ab12cd34...', description: 'Signing secret — shown only at creation.' },
                          active: { type: 'boolean' },
                          created_at: { type: 'string', format: 'date-time' }
                        }
                      }
                    }
                  }
                }
              }
            },
            '400': { description: 'Invalid URL (non-https off localhost), unknown event type, or unknown service slug' },
            '401': { description: 'Missing or invalid API key' },
            '429': RATE_LIMITED_RESPONSE
          }
        },
        get: {
          summary: 'List My Webhooks',
          description: 'Lists the authenticated agent\'s webhook subscriptions. Secrets are never included in list responses.',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'The caller\'s webhooks (no secrets)',
              headers: RATE_LIMIT_HEADERS,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agent_id: { type: 'string' },
                      count: { type: 'integer' },
                      webhooks: { type: 'array', items: { type: 'object' } }
                    }
                  }
                }
              }
            },
            '401': { description: 'Missing or invalid API key' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/agents/me/webhooks/{id}': {
        delete: {
          summary: 'Delete a Webhook Subscription',
          description: 'Deletes one of the authenticated agent\'s webhooks (404 if it does not exist or belongs to another agent). Its delivery log is removed with it. No further deliveries are sent.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'wh_1a2b3c4d5e6f' } }
          ],
          responses: {
            '200': { description: 'Webhook deleted', headers: RATE_LIMIT_HEADERS },
            '401': { description: 'Missing or invalid API key' },
            '404': { description: 'No such webhook for this agent' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/agents/me/webhooks/{id}/deliveries': {
        get: {
          summary: 'Webhook Delivery Log',
          description: 'Returns the 20 most recent delivery attempts for one of the authenticated agent\'s webhooks: status (pending/delivered/failed), attempt count, last HTTP status code, and last error.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'wh_1a2b3c4d5e6f' } }
          ],
          responses: {
            '200': {
              description: 'Recent deliveries for the webhook',
              headers: RATE_LIMIT_HEADERS,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      webhook_id: { type: 'string' },
                      count: { type: 'integer' },
                      deliveries: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            webhook_id: { type: 'string' },
                            event_type: { type: 'string', enum: ['incident.created', 'incident.resolved', 'change.detected'] },
                            status: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
                            attempts: { type: 'integer' },
                            last_status_code: { type: ['integer', 'null'] },
                            last_error: { type: ['string', 'null'] },
                            created_at: { type: 'string', format: 'date-time' },
                            delivered_at: { type: ['string', 'null'], format: 'date-time' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            '401': { description: 'Missing or invalid API key' },
            '404': { description: 'No such webhook for this agent' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/status/{service}': {
        get: {
          summary: 'Single Service Status & Incident Query',
          description: 'Returns current health, active incidents, affected regions/scope, and recommended fallback action in < 150 tokens. Supports If-None-Match (304 Not Modified). Quota (Step 3): unauthenticated calls are open and uncounted; authenticated calls count toward the daily quota, except conditional requests answered 304, which never consume quota and are never blocked.',
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
                'X-Good-Citizen-Score': { schema: { type: 'integer', example: 142 } },
                ...RATE_LIMIT_HEADERS
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
            '304': {
              description: 'Not Modified. Service state unchanged since provided ETag. Never consumes quota and is served even when the daily quota is exhausted.',
              headers: RATE_LIMIT_HEADERS
            },
            '404': { description: 'Service not found in registry.' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/preflight': {
        post: {
          summary: 'Batch Dependency Preflight Check',
          description: 'Agent sends an array of dependencies before running a toolchain or workflow; receives a single pass/degraded/block verdict. When the caller is authenticated and has a stored dependency manifest (PUT /v1/agents/me/dependencies), each requested service that is in the manifest also carries a compact `impact` verdict: { affected, incident_ids, change_ids, reason } — affected means an active incident or a breaking change detected in the last 90 days touches that service. Authenticated calls count toward the daily quota (429 when exhausted); unauthenticated calls are open and uncounted but carry no impact verdicts.',
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
              headers: RATE_LIMIT_HEADERS,
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
            },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/changes': {
        get: {
          summary: 'Delta Feed of Breaking Changes & Deprecations',
          description: 'Returns API, SDK, and schema deprecations detected since an ISO 8601 timestamp checkpoint. Each change object includes a `playbook_url` (Step 6) pointing at GET /v1/changes/{id}/playbook, its generated migration playbook.',
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
            },
            {
              name: 'scope',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['all', 'mine'], default: 'all' },
              description: 'scope=mine restricts the feed to services in the authenticated caller\'s dependency manifest. Requires Authorization: Bearer <api_key> (401 otherwise).'
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
                      service_filter: { type: 'string' },
                      scope: { type: 'string', description: 'Present when scope=mine was applied' },
                      changes: { type: 'array', items: { type: 'object' } }
                    }
                  }
                }
              }
            },
            '401': { description: 'scope=mine requested without a valid API key' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/changes/{id}/playbook': {
        get: {
          summary: 'Migration Playbook for a Breaking Change',
          description: 'Returns a structured, machine-readable migration playbook generated from the change\'s own fields (Step 6): { change_id, service, kind, summary, steps: [{ action, detail, code_example? }], effort_estimate (low|medium|high), risk_notes }. The kind is the fine-grained spec-diff kind for schema_diff changes (removed_operation, parameter_now_required, removed_response_property, ...) recovered from the recorded diff summary, or the stored change_type for deprecations / rate-limit changes. Code examples are generic fetch-style templates built only from the change\'s operation, path, and parameter/property names — no vendor facts are invented. Public read, like the changes feed; every change in GET /v1/changes carries a playbook_url pointing here.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'bc_spec_0123456789abcdef' }, description: 'Breaking change id from GET /v1/changes' }
          ],
          responses: {
            '200': {
              description: 'The migration playbook for the change',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      playbook: {
                        type: 'object',
                        properties: {
                          change_id: { type: 'string' },
                          service: { type: 'string', example: 'stripe' },
                          kind: { type: 'string', example: 'removed_operation' },
                          summary: { type: 'string' },
                          steps: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                action: { type: 'string', example: 'find_call_sites' },
                                detail: { type: 'string' },
                                code_example: {
                                  type: 'object',
                                  properties: {
                                    before: { type: 'string' },
                                    after: { type: 'string' }
                                  }
                                }
                              },
                              required: ['action', 'detail']
                            }
                          },
                          effort_estimate: { type: 'string', enum: ['low', 'medium', 'high'] },
                          risk_notes: { type: 'array', items: { type: 'string' } }
                        }
                      }
                    }
                  }
                }
              }
            },
            '404': { description: 'No breaking change with that id' }
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
      '/v1/telemetry/report': {
        post: {
          summary: 'Crowdsourced Outage Telemetry Report',
          description: 'Submit an observed 5xx error spike, timeout, or rate-limit anomaly to the anomaly-detection pipeline. Step 3: a valid API key is required (writes must be attributable to an agent) and the report counts toward the daily quota.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    service: { type: 'string', example: 'github' },
                    endpoint: { type: 'string', example: 'POST /repos/owner/repo/pulls' },
                    error_code: { type: 'integer', example: 502 },
                    error_type: { type: 'string', example: '502_bad_gateway' }
                  },
                  required: ['service', 'endpoint', 'error_code']
                }
              }
            }
          },
          responses: {
            '202': { description: 'Signal accepted into the anomaly detection pipeline', headers: RATE_LIMIT_HEADERS },
            '400': { description: 'Missing service, endpoint, or error_code' },
            '401': { description: 'Missing or invalid API key' },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      },
      '/v1/synthetic/probe': {
        post: {
          summary: 'Trigger a Synthetic Health Probe',
          description: 'Manually runs one synthetic probe against a service and records the result. Step 3: requires a valid API key (the trigger writes probe data) and counts toward the daily quota.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    service: { type: 'string', example: 'stripe', description: 'Service slug to probe (default: stripe)' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Probe result', headers: RATE_LIMIT_HEADERS },
            '401': { description: 'Missing or invalid API key' },
            '429': RATE_LIMITED_RESPONSE
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
          description: 'Model Context Protocol endpoint supporting check_dependency_health, lookup_breaking_changes, get_service_status, get_my_impact, and report_outage_signal via JSON-RPC 2.0 or Mcp-Method/Mcp-Name headers. Send Authorization: Bearer <api_key> to identify the calling agent: check_dependency_health then enriches manifest services with impact verdicts, and get_my_impact returns affected verdicts for the caller\'s whole manifest. Step 3: identified callers\' tool calls count toward the daily quota (429 with a JSON-RPC -32029 error when exhausted); report_outage_signal requires an identified caller (anonymous signals are rejected with a tool-level error). Anonymous read tools stay open.',
          responses: {
            '200': { description: 'MCP JSON-RPC response or streamable tool output', headers: RATE_LIMIT_HEADERS },
            '429': RATE_LIMITED_RESPONSE
          }
        }
      }
    }
  };
}
