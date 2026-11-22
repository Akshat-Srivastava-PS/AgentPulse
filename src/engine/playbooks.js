/**
 * Migration Playbooks (Step 6)
 *
 * Turns a breaking-change record into a structured, machine-readable
 * migration playbook an agent (or a human) can execute step by step:
 *
 *   {
 *     change_id, service, kind, summary,
 *     steps: [{ action, detail, code_example? }],
 *     effort_estimate: 'low' | 'medium' | 'high',
 *     risk_notes: [string]
 *   }
 *
 * Two input shapes are supported:
 *  - a `breaking_changes` DB row ({ id, service_slug, change_type,
 *    diff_summary, migration_hint, ... }) — the persisted form. Rows written
 *    by the Step 1 spec-diff worker carry change_type 'schema_diff' and a
 *    deterministic diff_summary; the fine-grained diff kind (removed
 *    operation, parameter now required, ...) is recovered by classifying
 *    that summary text.
 *  - a raw diff change object as returned by diffOpenApiSpecs
 *    ({ kind, location, summary, migration_hint }) — used when a playbook is
 *    wanted before/without persistence.
 *
 * Code examples are generic fetch-style templates built ONLY from the
 * change's own fields (operation, path, parameter/property name, types).
 * No vendor facts are invented: replacement endpoints, new parameter
 * semantics, etc. are never guessed — the playbook points at the provider's
 * migration hint / changelog instead.
 */

// --- Classification -------------------------------------------------------

const RE = {
  removed_path: /^Removed path (\S+?) entirely\./,
  removed_operation: /^Removed operation ([A-Z]+) (\S+?)\./,
  removed_parameter: /^Removed parameter '([^']+)' \(in: (\w+)\) from ([A-Z]+) (\S+?)\./,
  parameter_now_required: /^Parameter '([^']+)' \(in: (\w+)\) on ([A-Z]+) (\S+?) is now required\./,
  parameter_type_changed: /^Parameter '([^']+)' \(in: (\w+)\) on ([A-Z]+) (\S+?) changed type from (.+?) to ([^.]+)\./,
  new_required_parameter: /^New required parameter '([^']+)' \(in: (\w+)\) on ([A-Z]+) (\S+?)\./,
  removed_request_property: /^Removed request property '([^']+)' from ([A-Z]+) (\S+?)\./,
  request_property_now_required: /^Request property '([^']+)' on ([A-Z]+) (\S+?) is now required\./,
  new_required_request_property: /^New required request property '([^']+)' on ([A-Z]+) (\S+?)\./,
  request_property_type_changed: /^Request property '([^']+)' on ([A-Z]+) (\S+?) changed type from (.+?) to ([^.]+)\./,
  removed_response_property: /^Removed response property '([^']+)' from ([A-Z]+) (\S+?) success responses\./,
  response_property_type_changed: /^Response property '([^']+)' on ([A-Z]+) (\S+?) changed type from (.+?) to ([^.]+)\./,
  removed_response: /^Success response (\S+?) removed from ([A-Z]+) (\S+?)\./,
  removed_enum_value: /^Removed enum values? (.+?) from (?:(request|response) property|parameter) '([^']+)'(?: \(in: (\w+)\))? on ([A-Z]+) (\S+?)\./
};

function matchDetails(kind, m) {
  switch (kind) {
    case 'removed_path':
      return { path: m[1] };
    case 'removed_operation':
      return { method: m[1], path: m[2], operation: `${m[1]} ${m[2]}` };
    case 'removed_parameter':
    case 'parameter_now_required':
    case 'new_required_parameter':
      return { name: m[1], location: m[2], method: m[3], path: m[4], operation: `${m[3]} ${m[4]}` };
    case 'parameter_type_changed':
      return { name: m[1], location: m[2], method: m[3], path: m[4], operation: `${m[3]} ${m[4]}`, oldType: m[5], newType: m[6] };
    case 'removed_request_property':
    case 'request_property_now_required':
    case 'new_required_request_property':
      return { name: m[1], method: m[2], path: m[3], operation: `${m[2]} ${m[3]}` };
    case 'request_property_type_changed':
    case 'response_property_type_changed':
      return { name: m[1], method: m[2], path: m[3], operation: `${m[2]} ${m[3]}`, oldType: m[4], newType: m[5] };
    case 'removed_response_property':
      return { name: m[1], method: m[2], path: m[3], operation: `${m[2]} ${m[3]}` };
    case 'removed_response':
      return { responseCode: m[1], method: m[2], path: m[3], operation: `${m[2]} ${m[3]}` };
    case 'removed_enum_value':
      return { values: m[1], name: m[3], location: m[4], method: m[5], path: m[6], operation: `${m[5]} ${m[6]}` };
    default:
      return {};
  }
}

/**
 * Classifies a breaking change into a fine-grained kind and extracts the
 * structured details (operation, parameter/property name, types) that the
 * playbook steps and code examples are built from.
 */
export function classifyBreakingChange(change) {
  if (!change || typeof change !== 'object') return { kind: 'breaking_change', details: {} };

  const summary = String(change.diff_summary || change.summary || '');

  // Raw diff change: the kind is already known; still mine the summary for
  // details so steps/examples can be built the same way.
  if (change.kind && RE[change.kind]) {
    const m = summary.match(RE[change.kind]);
    return { kind: change.kind, details: m ? matchDetails(change.kind, m) : parseLocation(change.location) };
  }
  if (change.kind) return { kind: change.kind, details: parseLocation(change.location) };

  for (const [kind, re] of Object.entries(RE)) {
    const m = summary.match(re);
    if (m) return { kind, details: matchDetails(kind, m) };
  }

  // Non-schema-diff rows (deprecations, rate-limit changes, prose
  // schema notes) classify by their stored change_type.
  switch (change.change_type) {
    case 'deprecation': return { kind: 'deprecation', details: {} };
    case 'rate_limit_change': return { kind: 'rate_limit_change', details: {} };
    case 'schema_diff': return { kind: 'schema_change', details: {} };
    default: return { kind: 'breaking_change', details: {} };
  }
}

/** Best-effort detail extraction from a spec-diff `location` string. */
function parseLocation(location) {
  if (!location || typeof location !== 'string') return {};
  const opMatch = location.match(/^([A-Z]+) (\S+)/);
  const details = {};
  if (opMatch) {
    details.method = opMatch[1];
    details.path = opMatch[2];
    details.operation = `${opMatch[1]} ${opMatch[2]}`;
  } else if (location.startsWith('/')) {
    details.path = location;
  }
  const paramMatch = location.match(/param ([^:]+):(\w+)/);
  if (paramMatch) {
    details.name = paramMatch[1];
    details.location = paramMatch[2];
  }
  const propMatch = location.match(/(?:request|response) property (\S+)$/);
  if (propMatch && !details.name) details.name = propMatch[1];
  const codeMatch = location.match(/response (\S+)$/);
  if (codeMatch) details.responseCode = codeMatch[1];
  return details;
}

// --- Code-example templates (built only from the change's own fields) -----

function fetchCall(method, path, { query = null, headerParam = null, bodyProps = null } = {}) {
  const lines = [];
  let url = `API_BASE + '${path}'`;
  if (query) url += " + '?" + query.name + "=${encodeURIComponent(" + query.name + "Value)}'";
  lines.push(`const res = await fetch(${url}, {`);
  const opts = [];
  if (method && method !== 'GET') opts.push(`  method: '${method}'`);
  if (headerParam) {
    opts.push(`  headers: { '${headerParam.name}': ${headerParam.name}Value }`);
  }
  if (bodyProps) {
    const inner = bodyProps.map(p => `    ${p.name}: ${p.value}`).join(',\n');
    opts.push(`  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n${inner}\n  })`);
  }
  lines.push(opts.join(',\n'));
  lines.push('});');
  return lines.join('\n');
}

/**
 * Before/after fetch snippets for a parameter change.
 * include=true  → the parameter is being ADDED (after carries it).
 * include=false → the parameter is being REMOVED (before carries it).
 */
function paramExample(details, { include }) {
  const { method, path, name, location } = details;
  if (!method || !path || !name) return null;
  if (location === 'query' || location === 'header') {
    const opt = location === 'query' ? { query: { name } } : { headerParam: { name } };
    const withParam = fetchCall(method, path, opt);
    const withoutParam = fetchCall(method, path);
    return include ? { before: withoutParam, after: withParam } : { before: withParam, after: withoutParam };
  }
  // path / cookie / other locations: annotate instead of restructuring the URL.
  const plain = fetchCall(method, path);
  if (include) {
    return { before: plain, after: `${plain}\n// '${name}' (${location}) must now be supplied on every call — see provider docs for its value source.` };
  }
  return { before: `${plain}\n// '${name}' (${location}) was sent on this call`, after: `${plain}\n// '${name}' (${location}) removed — no longer sent` };
}

/**
 * Before/after fetch snippets for a request-body property change.
 * include=true  → the property is being ADDED (after carries it).
 * include=false → the property is being REMOVED (before carries it).
 */
function bodyPropertyExample(details, { include, value = '/* value */' }) {
  const { method, path, name } = details;
  if (!method || !path || !name) return null;
  const existing = { name: '/* existing fields */', value: '...' };
  const withProp = fetchCall(method, path, { bodyProps: [existing, { name, value }] });
  const withoutProp = fetchCall(method, path, { bodyProps: [existing] });
  return include ? { before: withoutProp, after: withProp } : { before: withProp, after: withoutProp };
}

// --- Per-kind playbook builders -------------------------------------------

function hintStep(change) {
  const hint = change.migration_hint;
  if (!hint) return null;
  return {
    action: 'review_provider_hint',
    detail: `Provider migration hint recorded with this change: ${hint}`
  };
}

function testStep(target) {
  return {
    action: 'update_tests',
    detail: `Update mocks/fixtures and add a regression test covering ${target}; run the full suite before deploying.`
  };
}

const BUILDERS = {
  removed_operation: (change, d) => ({
    effort: 'high',
    steps: [
      { action: 'find_call_sites', detail: `Search the codebase for every call to ${d.operation || 'the removed operation'} (path string, SDK method, and generated-client references).` },
      { action: 'identify_replacement', detail: `Check the provider changelog / migration hint for the replacement operation. Do not guess an endpoint — if no replacement is documented, treat the capability as removed.` },
      { action: 'rewire_or_remove', detail: `Migrate each call site to the documented replacement, or delete the code path if the capability is gone.` },
      { action: 'add_fallback', detail: `Until the migration ships, guard remaining call sites so a 404/410 from ${d.operation || 'the removed operation'} degrades gracefully (feature flag or fallback) instead of crashing the workflow.` },
      testStep(d.operation || 'the removed operation')
    ],
    risk_notes: [
      'Calls to a removed operation typically fail with 404/410 at runtime — any missed call site becomes a production error.',
      'If a third-party SDK wraps this operation, the SDK version itself may need an upgrade or a pin.'
    ]
  }),

  removed_path: (change, d) => ({
    effort: 'high',
    steps: [
      { action: 'find_call_sites', detail: `Search the codebase for every reference to the path ${d.path || '(unknown path)'} and the operations under it.` },
      { action: 'identify_replacement', detail: 'Check the provider changelog / migration hint for where this surface moved. Do not guess a new path.' },
      { action: 'rewire_or_remove', detail: 'Migrate each call site to the documented replacement path, or delete the code path if the capability is gone.' },
      { action: 'add_fallback', detail: `Guard remaining call sites so a 404 from ${d.path || 'the removed path'} degrades gracefully instead of crashing the workflow.` },
      testStep(d.path || 'the removed path')
    ],
    risk_notes: [
      'Every operation under a removed path is gone at once — audit all HTTP methods, not just the ones you call today.',
      'Webhooks or callbacks registered against the old path may silently stop firing.'
    ]
  }),

  removed_parameter: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_call_sites', detail: `Find every call to ${d.operation || 'the operation'} that sends the '${d.name}' parameter (${d.location || 'parameter'}).` },
      { action: 'stop_sending', detail: `Remove '${d.name}' from those calls. Check the migration hint first — if the parameter was renamed, send the new name instead of just dropping it.`, code_example: paramExample(d, { include: false }) || undefined },
      testStep(`${d.operation || 'the operation'} without '${d.name}'`)
    ],
    risk_notes: [
      'Strict servers may reject unknown parameters; lenient ones ignore them — either way the parameter no longer has any effect, so logic that relied on it silently changes behavior.'
    ]
  }),

  parameter_now_required: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_call_sites', detail: `Find every call to ${d.operation || 'the operation'} that does not send the '${d.name}' parameter (${d.location || 'parameter'}) — those calls now fail validation.` },
      { action: 'add_parameter', detail: `Always send '${d.name}' when calling ${d.operation || 'the operation'}. Source its value from the same place the provider documents; do not hard-code a placeholder.`, code_example: paramExample(d, { include: true }) || undefined },
      testStep(`${d.operation || 'the operation'} with '${d.name}' always present`)
    ],
    risk_notes: [
      `Calls missing '${d.name}' will start failing with validation errors (typically HTTP 400) as soon as the provider enforces the new spec.`
    ]
  }),

  new_required_parameter: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_call_sites', detail: `Find every call to ${d.operation || 'the operation'} — all of them must now send the new '${d.name}' parameter (${d.location || 'parameter'}).` },
      { action: 'add_parameter', detail: `Add '${d.name}' to every call to ${d.operation || 'the operation'}; calls without it fail validation. Source its value from the provider documentation, not a guess.`, code_example: paramExample(d, { include: true }) || undefined },
      testStep(`${d.operation || 'the operation'} including the new '${d.name}' parameter`)
    ],
    risk_notes: [
      'This breaks every existing call site at once, including rarely-run code paths (cron jobs, retries, admin scripts).'
    ]
  }),

  parameter_type_changed: (change, d) => ({
    effort: 'medium',
    steps: [
      { action: 'find_call_sites', detail: `Find every call to ${d.operation || 'the operation'} that sends '${d.name}' (${d.location || 'parameter'}).` },
      { action: 'convert_type', detail: `Send '${d.name}' as ${d.newType || 'the new type'} instead of ${d.oldType || 'the old type'} on ${d.operation || 'the operation'}; convert at the call site or in the request builder, not ad hoc per caller.` },
      testStep(`'${d.name}' sent as ${d.newType || 'the new type'} to ${d.operation || 'the operation'}`)
    ],
    risk_notes: [
      `Type mismatches are often rejected with HTTP 400, but some servers silently coerce — verify the value the provider actually receives.`
    ]
  }),

  removed_request_property: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_call_sites', detail: `Find every request to ${d.operation || 'the operation'} that includes the '${d.name}' property in its body.` },
      { action: 'stop_sending', detail: `Remove '${d.name}' from request bodies to ${d.operation || 'the operation'}.`, code_example: bodyPropertyExample(d, { include: false }) || undefined },
      testStep(`${d.operation || 'the operation'} request bodies without '${d.name}'`)
    ],
    risk_notes: [
      'If any logic depended on the provider acting on this property, that behavior is gone — check for silent no-ops.'
    ]
  }),

  request_property_now_required: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_call_sites', detail: `Find every request to ${d.operation || 'the operation'} whose body can omit '${d.name}'.` },
      { action: 'add_property', detail: `Always include '${d.name}' in request bodies to ${d.operation || 'the operation'}; requests without it fail validation.`, code_example: bodyPropertyExample(d, { include: true }) || undefined },
      testStep(`${d.operation || 'the operation'} bodies always including '${d.name}'`)
    ],
    risk_notes: [
      `Optional-until-now fields are commonly built conditionally — audit builders, partial-update (PATCH) paths, and test fixtures, not just the main create path.`
    ]
  }),

  new_required_request_property: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_call_sites', detail: `Find every request builder for ${d.operation || 'the operation'} — all of them must now include '${d.name}'.` },
      { action: 'add_property', detail: `Add '${d.name}' to every request body to ${d.operation || 'the operation'}; requests without it fail validation. Source its value from the provider documentation.`, code_example: bodyPropertyExample(d, { include: true }) || undefined },
      testStep(`${d.operation || 'the operation'} bodies including the new '${d.name}' property`)
    ],
    risk_notes: [
      'This breaks every existing request at once, including rarely-run code paths (retries, backfills, admin scripts).'
    ]
  }),

  request_property_type_changed: (change, d) => ({
    effort: 'medium',
    steps: [
      { action: 'find_call_sites', detail: `Find every request to ${d.operation || 'the operation'} that sets '${d.name}' in its body.` },
      { action: 'convert_type', detail: `Send '${d.name}' as ${d.newType || 'the new type'} instead of ${d.oldType || 'the old type'} in bodies to ${d.operation || 'the operation'}; convert centrally in the request builder.` },
      testStep(`'${d.name}' sent as ${d.newType || 'the new type'} to ${d.operation || 'the operation'}`)
    ],
    risk_notes: [
      'JSON type changes (e.g. string → integer) often pass local validation and fail only at the provider — assert on the serialized body in tests.'
    ]
  }),

  removed_response_property: (change, d) => ({
    effort: 'medium',
    steps: [
      { action: 'find_usages', detail: `Find every read of '${d.name}' from ${d.operation || 'the operation'} responses (direct property access, destructuring, schema validation, persisted copies).` },
      {
        action: 'stop_reading',
        detail: `Stop reading '${d.name}' — it is no longer returned. Guard any unavoidable read so a missing property cannot throw.`,
        code_example: (d.name ? {
          before: `const value = response.${d.name};`,
          after: `const value = response.${d.name} ?? null; // '${d.name}' is no longer returned by ${d.operation || 'this operation'} — every read must tolerate its absence`
        } : undefined)
      },
      { action: 'find_alternative', detail: `Check the migration hint / provider changelog for a replacement field or endpoint that now carries this data. Do not assume one exists.` },
      testStep(`handling of ${d.operation || 'the operation'} responses without '${d.name}'`)
    ],
    risk_notes: [
      'Missing-property reads fail silently in loosely-typed code (undefined propagating downstream) — search beyond the immediate call site.',
      'If responses are persisted or cached, historical records still contain the property while new ones do not — handle both shapes.'
    ]
  }),

  response_property_type_changed: (change, d) => ({
    effort: 'medium',
    steps: [
      { action: 'find_usages', detail: `Find every read of '${d.name}' from ${d.operation || 'the operation'} responses.` },
      { action: 'convert_type', detail: `Handle '${d.name}' as ${d.newType || 'the new type'} instead of ${d.oldType || 'the old type'}: update parsing, comparisons, arithmetic, and any schema validation on that value.` },
      testStep(`'${d.name}' handled as ${d.newType || 'the new type'} from ${d.operation || 'the operation'}`)
    ],
    risk_notes: [
      'Type changes in responses break strict schema validators and typed clients first — check generated types and validation layers.',
      'Persisted historical values keep the old type; migrations or dual-shape handling may be needed.'
    ]
  }),

  removed_enum_value: (change, d) => ({
    effort: 'low',
    steps: [
      { action: 'find_usages', detail: `Find every place that sends, expects, or branches on the removed enum value(s) ${d.values || '(see summary)'} for '${d.name || 'the field'}' on ${d.operation || 'the operation'} — request builders, response parsers, switch statements, and validation schemas.` },
      { action: 'map_or_remove', detail: `Map each removed value to a remaining enum value where the provider documents an equivalent; otherwise remove the code path. Do not invent a mapping the provider does not document.` },
      testStep(`handling of '${d.name || 'the field'}' without the removed enum value(s) on ${d.operation || 'the operation'}`)
    ],
    risk_notes: [
      'Strict validators and generated clients reject removed enum values immediately; loosely-typed code may pass them through and fail later at the provider.',
      'Persisted records may still hold the removed values — queries and reports over historical data need a mapping too.'
    ]
  }),

  removed_response: (change, d) => ({
    effort: 'medium',
    steps: [
      { action: 'find_call_sites', detail: `Find code that calls ${d.operation || 'the operation'} and branches on HTTP ${d.responseCode || 'the removed status code'} (success checks, status-code switches, retry logic).` },
      { action: 'handle_remaining_responses', detail: `Update success handling for ${d.operation || 'the operation'} to rely only on the remaining success responses; do not treat HTTP ${d.responseCode || 'the removed code'} as success anymore.` },
      testStep(`success handling for ${d.operation || 'the operation'} without HTTP ${d.responseCode || 'the removed code'}`)
    ],
    risk_notes: [
      'Code that treats any 2xx as success is unaffected; code keyed to the exact removed code will misclassify responses.'
    ]
  }),

  deprecation: (change) => ({
    effort: 'medium',
    steps: [
      { action: 'find_call_sites', detail: 'Find every use of the deprecated surface named in the change summary.' },
      { action: 'follow_migration_hint', detail: 'Migrate to the replacement named in the migration hint / provider changelog. Do not invent a replacement if none is documented.' },
      { action: 'add_fallback', detail: 'Until the migration ships, make failures of the deprecated surface degrade gracefully (fallback or feature flag) rather than crash the workflow.' },
      testStep('the migrated replacement surface')
    ],
    risk_notes: [
      'Deprecations become removals: after the removal date the old surface fails at runtime.',
      'SDK upgrades that perform the migration may bundle other breaking changes — review their changelog too.'
    ]
  }),

  rate_limit_change: (change) => ({
    effort: 'medium',
    steps: [
      { action: 'measure_current_rate', detail: 'Measure your current request rate against the tightened limit in the change summary (peak, not average).' },
      { action: 'add_pacing', detail: 'Add client-side pacing (token bucket or queue) and honor 429 + Retry-After with exponential backoff on the affected endpoints.' },
      { action: 'reduce_calls', detail: 'Cut avoidable calls: cache responses (ETag/304 where offered), batch where the API allows, and drop polling intervals below the new budget.' },
      testStep('rate-limit handling (429 + Retry-After backoff)')
    ],
    risk_notes: [
      'Burst traffic (deploys, backfills, retry storms) hits tightened limits first — pace those paths explicitly.'
    ]
  }),

  schema_change: (change) => ({
    effort: 'medium',
    steps: [
      { action: 'review_change', detail: 'Read the change summary and migration hint carefully — this schema change did not match a finer-grained pattern, so classify it manually before editing code.' },
      { action: 'find_call_sites', detail: 'Find every call site and response handler touching the affected service surface.' },
      { action: 'apply_hint', detail: 'Apply the recorded migration hint exactly; where it is ambiguous, check the provider changelog rather than guessing.' },
      testStep('the affected surface')
    ],
    risk_notes: [
      'Unclassified schema changes carry the highest uncertainty — verify behavior against the provider sandbox or a canary call before rolling out.'
    ]
  }),

  breaking_change: (change) => ({
    effort: 'medium',
    steps: [
      { action: 'review_change', detail: 'Read the change summary and migration hint carefully and identify the exact surface that changed.' },
      { action: 'find_call_sites', detail: 'Find every call site and response handler touching the affected surface.' },
      { action: 'apply_hint', detail: 'Apply the recorded migration hint exactly; where it is ambiguous, check the provider changelog rather than guessing.' },
      testStep('the affected surface')
    ],
    risk_notes: [
      'Breaking changes fail at runtime, not at build time — prioritize call sites on hot paths.'
    ]
  })
};

/**
 * Builds the migration playbook for a breaking change (DB row or raw diff
 * change). Pure function — no I/O.
 */
export function buildPlaybook(change) {
  const { kind, details } = classifyBreakingChange(change);
  const builder = BUILDERS[kind] || BUILDERS.breaking_change;
  const built = builder(change, details);

  const steps = [];
  const hint = hintStep(change);
  if (hint) steps.push(hint);
  steps.push(...built.steps);

  return {
    change_id: change.id || null,
    service: change.service_slug || change.service || null,
    kind,
    summary: String(change.diff_summary || change.summary || ''),
    steps,
    effort_estimate: built.effort,
    risk_notes: built.risk_notes
  };
}
