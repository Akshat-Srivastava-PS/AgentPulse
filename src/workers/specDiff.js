/**
 * OpenAPI Spec-Diff Worker (Step 1: real ingestion)
 *
 * Fetches tracked OpenAPI specs, hashes them, and when a spec changes versus
 * the last stored snapshot, diffs old vs new and records the breaking changes
 * as real rows in `breaking_changes` (change_type 'schema_diff', deterministic
 * ids so re-processing the same transition never duplicates a row).
 *
 * Snapshots are stored in the `spec_snapshots` table. The first fetch of a
 * spec is a baseline: it is stored but produces no changes (there is nothing
 * to diff against yet).
 *
 * Offline behaviour: fetch/parse failures are logged and skipped. This module
 * never throws into the server or the scheduler.
 */
import crypto from 'node:crypto';
import {
  getService,
  getLatestSpecSnapshot,
  saveSpecSnapshot,
  getBreakingChangeById,
  createBreakingChange
} from '../db/index.js';

/**
 * Service slug -> OpenAPI spec URL (JSON).
 * Stripe and GitHub publish JSON specs on GitHub raw. OpenAI's canonical
 * openai-openapi repo publishes YAML; its entry points at that document and
 * the poller will log-and-skip it (non-JSON) until a JSON mirror is set via
 * SPEC_SOURCES_JSON, e.g.
 *   SPEC_SOURCES_JSON='{"openai":"https://example.com/openai.json"}'
 */
export const SPEC_REGISTRY = {
  stripe: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  github: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
  openai: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml'
};

export function getSpecRegistry() {
  const override = process.env.SPEC_SOURCES_JSON;
  if (!override) return { ...SPEC_REGISTRY };
  try {
    const parsed = JSON.parse(override);
    if (parsed && typeof parsed === 'object') return { ...parsed };
  } catch (err) {
    console.error('[SpecDiff] Invalid SPEC_SOURCES_JSON, using defaults:', err.message);
  }
  return { ...SPEC_REGISTRY };
}

export function hashSpecText(rawText) {
  return crypto.createHash('sha256').update(String(rawText)).digest('hex');
}

// Max depth for recursive schema walking (nested properties, array items,
// allOf branches). Pathological or circular schemas are cut off here and by
// the $ref chain guard in objectChildView().
const MAX_PROPERTY_DEPTH = 10;

// --- $ref resolution (local refs only, depth-limited) ---

function lookupRef(spec, ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  let node = spec;
  for (const part of ref.substring(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return null;
    node = node[key];
  }
  return node ?? null;
}

function resolveRef(spec, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return node;
  if (typeof node.$ref === 'string') {
    const target = lookupRef(spec, node.$ref);
    if (target) return resolveRef(spec, { ...target, ...node, $ref: undefined }, depth + 1);
  }
  return node;
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type) return schema.format ? `${schema.type}:${schema.format}` : schema.type;
  if (schema.format) return schema.format;
  if (schema.enum) return 'enum';
  return null;
}

function schemaProperties(spec, schema, depth = 0) {
  const resolved = resolveRef(spec, schema);
  if (!resolved || typeof resolved !== 'object') return { properties: {}, required: [] };

  let properties = { ...(resolved.properties || {}) };
  let required = [...(resolved.required || [])];
  if (Array.isArray(resolved.allOf) && depth < MAX_PROPERTY_DEPTH) {
    for (const part of resolved.allOf) {
      const sub = schemaProperties(spec, part, depth + 1);
      properties = { ...properties, ...sub.properties };
      required = [...new Set([...required, ...sub.required])];
    }
  }
  return { properties, required };
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

function collectOperations(spec) {
  const ops = new Map(); // "GET /path" -> { method, path, operation, pathItem }
  for (const [pathKey, pathItem] of Object.entries(spec?.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      if (pathItem[method] && typeof pathItem[method] === 'object') {
        ops.set(`${method.toUpperCase()} ${pathKey}`, { method, path: pathKey, operation: pathItem[method], pathItem });
      }
    }
  }
  return ops;
}

function collectParameters(spec, { operation, pathItem }) {
  const params = new Map(); // "name:in" -> resolved parameter
  for (const raw of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
    const param = resolveRef(spec, raw);
    if (param && param.name && param.in) {
      params.set(`${param.name}:${param.in}`, param);
    }
  }
  return params;
}

function jsonSchemaOf(spec, container) {
  const content = container?.content;
  if (!content || typeof content !== 'object') return null;
  const media = content['application/json'] || Object.values(content)[0];
  return media?.schema ? resolveRef(spec, media.schema) : null;
}

function requestSchema(spec, operation) {
  return operation.requestBody ? jsonSchemaOf(spec, resolveRef(spec, operation.requestBody)) : null;
}

function successResponseSchema(spec, operation) {
  const responses = operation.responses || {};
  for (const code of Object.keys(responses).sort()) {
    if (/^2\d\d$/.test(code) || code === '2XX') {
      return jsonSchemaOf(spec, resolveRef(spec, responses[code]));
    }
  }
  return null;
}

function successResponseCodes(operation) {
  return Object.keys(operation.responses || {}).filter(c => /^2\d\d$/.test(c) || c === '2XX');
}

function makeChange(kind, breaking, location, summary, migrationHint) {
  return { kind, breaking, location, summary, migration_hint: migrationHint };
}

/**
 * Pure diff: compares two parsed OpenAPI documents and returns a list of
 * changes, breaking first. Exported for offline unit tests.
 *
 * Breaking rules:
 *  - removed path or removed operation
 *  - removed parameter; parameter that becomes required; parameter type change
 *  - newly required parameter (added with required=true)
 *  - removed request-body property; request property that becomes required;
 *    newly required request property; request property type change
 *  - removed response property; response property type change
 *  - removed enum value on a parameter or a request/response property
 *  - removed 2xx success response
 * Non-breaking: added paths/operations, added optional parameters, added
 * optional request properties, added response properties.
 *
 * Property comparison is recursive: nested object properties, array item
 * schemas, and local $ref targets are all followed (depth- and cycle-guarded),
 * and locations carry the dotted property path, e.g.
 * `GET /v1/charges response property customer.email`.
 */
export function diffOpenApiSpecs(oldSpec, newSpec) {
  const changes = [];
  if (!oldSpec || !newSpec) return changes;

  const oldOps = collectOperations(oldSpec);
  const newOps = collectOperations(newSpec);
  const oldPaths = new Set(Object.keys(oldSpec.paths || {}));
  const newPaths = new Set(Object.keys(newSpec.paths || {}));

  for (const pathKey of oldPaths) {
    if (!newPaths.has(pathKey)) {
      changes.push(makeChange('removed_path', true, pathKey,
        `Removed path ${pathKey} entirely.`,
        `Remove all calls to ${pathKey}; find the replacement endpoint in the provider changelog.`));
    }
  }
  for (const pathKey of newPaths) {
    if (!oldPaths.has(pathKey)) {
      changes.push(makeChange('added_path', false, pathKey,
        `Added new path ${pathKey}.`,
        'No action required; new capability available.'));
    }
  }

  for (const [opKey, oldOp] of oldOps) {
    if (oldPaths.has(oldOp.path) && !newPaths.has(oldOp.path)) continue; // covered by removed_path
    const newOp = newOps.get(opKey);
    if (!newOp) {
      changes.push(makeChange('removed_operation', true, opKey,
        `Removed operation ${opKey}.`,
        `Remove all calls to ${opKey}; migrate to the provider's replacement operation.`));
      continue;
    }
    diffOperation(oldSpec, newSpec, opKey, oldOp, newOp, changes);
  }

  for (const [opKey, newOp] of newOps) {
    if (!oldOps.has(opKey) && newPaths.has(newOp.path) && oldPaths.has(newOp.path)) {
      changes.push(makeChange('added_operation', false, opKey,
        `Added new operation ${opKey}.`,
        'No action required; new capability available.'));
    }
  }

  return changes.sort((a, b) => Number(b.breaking) - Number(a.breaking));
}

function diffOperation(oldSpec, newSpec, opKey, oldOp, newOp, changes) {
  // --- Parameters ---
  const oldParams = collectParameters(oldSpec, oldOp);
  const newParams = collectParameters(newSpec, newOp);

  for (const [key, oldParam] of oldParams) {
    const newParam = newParams.get(key);
    if (!newParam) {
      changes.push(makeChange('removed_parameter', true, `${opKey} param ${key}`,
        `Removed parameter '${oldParam.name}' (in: ${oldParam.in}) from ${opKey}.`,
        `Stop sending '${oldParam.name}' to ${opKey}; check whether it was renamed in the new spec.`));
      continue;
    }
    if (!oldParam.required && newParam.required) {
      changes.push(makeChange('parameter_now_required', true, `${opKey} param ${key}`,
        `Parameter '${oldParam.name}' (in: ${oldParam.in}) on ${opKey} is now required.`,
        `Always send '${oldParam.name}' when calling ${opKey}.`));
    }
    const oldType = schemaType(oldParam.schema);
    const newType = schemaType(newParam.schema);
    if (oldType && newType && oldType !== newType) {
      changes.push(makeChange('parameter_type_changed', true, `${opKey} param ${key}`,
        `Parameter '${oldParam.name}' (in: ${oldParam.in}) on ${opKey} changed type from ${oldType} to ${newType}.`,
        `Update the value type sent for '${oldParam.name}' on ${opKey} to ${newType}.`));
    }
    diffEnumValues(changes, `${opKey} param ${key}`,
      `parameter '${oldParam.name}' (in: ${oldParam.in}) on ${opKey}`,
      resolveRef(oldSpec, oldParam.schema), resolveRef(newSpec, newParam.schema));
  }
  for (const [key, newParam] of newParams) {
    if (!oldParams.has(key)) {
      if (newParam.required) {
        changes.push(makeChange('new_required_parameter', true, `${opKey} param ${key}`,
          `New required parameter '${newParam.name}' (in: ${newParam.in}) on ${opKey}.`,
          `Add '${newParam.name}' to every call to ${opKey}; calls without it will fail validation.`));
      } else {
        changes.push(makeChange('added_optional_parameter', false, `${opKey} param ${key}`,
          `Added optional parameter '${newParam.name}' (in: ${newParam.in}) to ${opKey}.`,
          'No action required.'));
      }
    }
  }

  // --- Request body properties (recursive) ---
  const oldReq = schemaProperties(oldSpec, requestSchema(oldSpec, oldOp.operation));
  const newReq = schemaProperties(newSpec, requestSchema(newSpec, newOp.operation));
  diffProperties(changes, opKey, 'request', oldSpec, newSpec, oldReq, newReq);

  // --- Response properties (recursive) ---
  const oldRes = schemaProperties(oldSpec, successResponseSchema(oldSpec, oldOp.operation));
  const newRes = schemaProperties(newSpec, successResponseSchema(newSpec, newOp.operation));
  diffProperties(changes, opKey, 'response', oldSpec, newSpec, oldRes, newRes);

  // --- Removed success responses ---
  const newCodes = new Set(successResponseCodes(newOp.operation));
  for (const code of successResponseCodes(oldOp.operation)) {
    if (!newCodes.has(code)) {
      changes.push(makeChange('removed_response', true, `${opKey} response ${code}`,
        `Success response ${code} removed from ${opKey}.`,
        `Handle the remaining success responses for ${opKey}; do not rely on HTTP ${code}.`));
    }
  }
}

function formatEnumValue(value) {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

/**
 * Emits a breaking `removed_enum_value` change when enum values present in
 * the old schema are gone from the new one. `label` completes the summary,
 * e.g. "response property 'status' on GET /v1/charges" or
 * "parameter 'state' (in: query) on GET /v1/charges". Schemas are expected to
 * be $ref-resolved by the caller. Dropping an enum entirely (new schema has
 * none) widens the accepted set and is not reported.
 */
function diffEnumValues(changes, location, label, oldSchema, newSchema) {
  const oldEnum = Array.isArray(oldSchema?.enum) ? oldSchema.enum : null;
  const newEnum = Array.isArray(newSchema?.enum) ? newSchema.enum : null;
  if (!oldEnum || !newEnum) return;
  const newKeys = new Set(newEnum.map(v => JSON.stringify(v)));
  const removed = oldEnum.filter(v => !newKeys.has(JSON.stringify(v)));
  if (!removed.length) return;
  const list = removed.map(formatEnumValue).join(', ');
  changes.push(makeChange('removed_enum_value', true, location,
    `Removed enum value${removed.length > 1 ? 's' : ''} ${list} from ${label}.`,
    `The value${removed.length > 1 ? 's' : ''} ${list} no longer exist for ${label}; map them to a remaining value or remove the code paths that rely on them.`));
}

/**
 * Extracts the { properties, required } view of an object-like property
 * schema, following local $refs and descending through array `items`.
 * Returns null when the schema does not describe an object with properties,
 * or when following it would revisit a $ref already on this descent path
 * (circular schema, e.g. Category.parent -> Category). `viaArray` records
 * whether the view was reached through `items`; `refChain` is the extended
 * set of refs followed to reach the view.
 */
function objectChildView(spec, schema, refChain) {
  let current = schema;
  const chain = new Set(refChain);
  let viaArray = false;
  for (let hops = 0; hops <= MAX_PROPERTY_DEPTH; hops++) {
    if (!current || typeof current !== 'object') return null;
    if (typeof current.$ref === 'string') {
      if (chain.has(current.$ref)) return null; // circular $ref — stop descending
      chain.add(current.$ref);
    }
    const resolved = resolveRef(spec, current);
    if (!resolved || typeof resolved !== 'object') return null;
    if (resolved.properties || Array.isArray(resolved.allOf)) {
      const view = schemaProperties(spec, current);
      return { properties: view.properties, required: view.required, viaArray, refChain: chain };
    }
    if (resolved.type === 'array' && resolved.items) {
      viaArray = true;
      current = resolved.items;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Recursive property diff. `oldSide`/`newSide` are { properties, required }
 * views of one schema level; `prefix` is the dotted path of that level (''
 * at the top, `customer` / `line_items[]` below it). Nested levels reuse the
 * top-level change kinds with the dotted path in location and summary.
 */
function diffProperties(changes, opKey, side, oldSpec, newSpec, oldSide, newSide, prefix = '', depth = 0, refChain = new Set()) {
  const isRequest = side === 'request';
  const dotted = (name) => (prefix ? `${prefix}.${name}` : name);

  for (const [name, oldProp] of Object.entries(oldSide.properties)) {
    const path = dotted(name);
    const newProp = newSide.properties[name];
    if (!newProp) {
      changes.push(makeChange(
        isRequest ? 'removed_request_property' : 'removed_response_property', true,
        `${opKey} ${side} property ${path}`,
        isRequest
          ? `Removed request property '${path}' from ${opKey}.`
          : `Removed response property '${path}' from ${opKey} success responses.`,
        isRequest
          ? `Stop sending '${path}' in requests to ${opKey}.`
          : `Stop reading '${path}' from ${opKey} responses; it is no longer returned.`));
      continue;
    }
    if (isRequest && !oldSide.required.includes(name) && newSide.required.includes(name)) {
      changes.push(makeChange('request_property_now_required', true, `${opKey} request property ${path}`,
        `Request property '${path}' on ${opKey} is now required.`,
        `Always include '${path}' in requests to ${opKey}.`));
    }
    const oldResolved = resolveRef(oldSpec, oldProp);
    const newResolved = resolveRef(newSpec, newProp);
    const oldType = schemaType(oldResolved);
    const newType = schemaType(newResolved);
    if (oldType && newType && oldType !== newType) {
      changes.push(makeChange(
        isRequest ? 'request_property_type_changed' : 'response_property_type_changed', true,
        `${opKey} ${side} property ${path}`,
        `${isRequest ? 'Request' : 'Response'} property '${path}' on ${opKey} changed type from ${oldType} to ${newType}.`,
        `Update the ${side} handling of '${path}' on ${opKey} to type ${newType}.`));
    }
    diffEnumValues(changes, `${opKey} ${side} property ${path}`,
      `${side} property '${path}' on ${opKey}`, oldResolved, newResolved);

    // Recurse into nested object properties (through array items and $refs).
    // Descent stops at MAX_PROPERTY_DEPTH, and objectChildView refuses to
    // follow a $ref already on this path, so circular schemas terminate.
    if (depth < MAX_PROPERTY_DEPTH) {
      const oldChild = objectChildView(oldSpec, oldProp, refChain);
      const newChild = objectChildView(newSpec, newProp, refChain);
      if (oldChild && newChild && oldChild.viaArray === newChild.viaArray) {
        const childChain = new Set([...oldChild.refChain, ...newChild.refChain]);
        diffProperties(changes, opKey, side, oldSpec, newSpec, oldChild, newChild,
          oldChild.viaArray ? `${path}[]` : path, depth + 1, childChain);
      }
    }
  }
  for (const name of Object.keys(newSide.properties)) {
    if (!(name in oldSide.properties)) {
      const path = dotted(name);
      if (isRequest && newSide.required.includes(name)) {
        changes.push(makeChange('new_required_request_property', true, `${opKey} request property ${path}`,
          `New required request property '${path}' on ${opKey}.`,
          `Include '${path}' in every request to ${opKey}.`));
      } else {
        changes.push(makeChange(
          isRequest ? 'added_request_property' : 'added_response_property', false,
          `${opKey} ${side} property ${path}`,
          `Added ${side} property '${path}' to ${opKey}.`,
          'No action required.'));
      }
    }
  }
}

/** Deterministic breaking-change id for one detected spec change (dedupe key). */
export function specChangeId(serviceSlug, specUrl, change) {
  const fingerprint = `${serviceSlug}|${specUrl}|${change.kind}|${change.location}|${change.summary}`;
  const hash = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 16);
  return `bc_spec_${hash}`;
}

/**
 * Processes one fetched spec document (raw text) for a service: stores a new
 * snapshot when the hash changed and inserts breaking-change rows for the
 * diff. Returns a result summary; never throws on bad input.
 */
export function processFetchedSpec(serviceSlug, specUrl, rawText) {
  const result = { service: serviceSlug, changed: false, baseline: false, inserted: 0, duplicates: 0, changes: [] };
  if (!getService(serviceSlug)) {
    result.skipped_service = true;
    return result;
  }

  let spec;
  try {
    spec = JSON.parse(rawText);
  } catch (err) {
    console.warn(`[SpecDiff] ${serviceSlug}: spec at ${specUrl} is not valid JSON (skipping): ${err.message}`);
    result.error = 'invalid_json';
    return result;
  }

  const specHash = hashSpecText(rawText);
  const latest = getLatestSpecSnapshot(serviceSlug, specUrl);

  if (latest && latest.spec_hash === specHash) {
    return result; // unchanged
  }

  result.changed = true;

  if (!latest) {
    saveSpecSnapshot({ service_slug: serviceSlug, spec_url: specUrl, spec_hash: specHash, spec_json: rawText });
    result.baseline = true;
    return result;
  }

  let oldSpec = null;
  try {
    oldSpec = JSON.parse(latest.spec_json);
  } catch {
    console.warn(`[SpecDiff] ${serviceSlug}: stored snapshot is corrupt; treating fetch as new baseline`);
  }

  if (oldSpec) {
    const changes = diffOpenApiSpecs(oldSpec, spec);
    result.changes = changes;
    const versionOrDate = (spec.info && spec.info.version) || new Date().toISOString().substring(0, 10);

    for (const change of changes.filter(c => c.breaking)) {
      const id = specChangeId(serviceSlug, specUrl, change);
      if (getBreakingChangeById(id)) {
        result.duplicates++;
        continue;
      }
      createBreakingChange({
        id,
        service_slug: serviceSlug,
        version_or_date: String(versionOrDate),
        change_type: 'schema_diff',
        kind: change.kind,
        location: change.location,
        diff_summary: `${change.summary} (source: ${specUrl})`,
        migration_hint: change.migration_hint
      });
      result.inserted++;
    }
  } else {
    result.baseline = true;
  }

  saveSpecSnapshot({ service_slug: serviceSlug, spec_url: specUrl, spec_hash: specHash, spec_json: rawText });
  return result;
}

/** Polls one service's spec. Never throws; returns null on fetch failure. */
export async function pollSpecService(serviceSlug, fetchImpl = globalThis.fetch) {
  const registry = getSpecRegistry();
  const specUrl = registry[serviceSlug];
  if (!specUrl) return null;
  if (!getService(serviceSlug)) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let rawText;
    try {
      const res = await fetchImpl(specUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AgentPulse-SpecDiff/1.0', 'Accept': 'application/json' }
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
      rawText = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    const result = processFetchedSpec(serviceSlug, specUrl, rawText);
    if (result.inserted > 0) {
      console.log(`[SpecDiff] ${serviceSlug}: ${result.inserted} new breaking change(s) recorded from ${specUrl}`);
    }
    return result;
  } catch (err) {
    console.warn(`[SpecDiff] ${serviceSlug} spec poll failed (skipping): ${err.message}`);
    return null;
  }
}

/** Polls every registered spec sequentially. Never throws. */
export async function pollAllSpecDiffs(fetchImpl = globalThis.fetch) {
  const results = [];
  for (const slug of Object.keys(getSpecRegistry())) {
    const result = await pollSpecService(slug, fetchImpl);
    if (result) results.push(result);
  }
  return results;
}

// --- Scheduler wiring (started/stopped by the ingestion worker) ---

let pollerInterval = null;

export function startSpecDiffPoller(intervalMs = 3600000) {
  if (pollerInterval) return;
  console.log(`[SpecDiff] Started scheduled polling every ${Math.round(intervalMs / 1000)}s`);
  setTimeout(() => { pollAllSpecDiffs().catch(() => {}); }, 15000);
  pollerInterval = setInterval(() => {
    pollAllSpecDiffs().catch(err => console.warn('[SpecDiff] Cycle failed:', err.message));
  }, intervalMs);
}

export function stopSpecDiffPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[SpecDiff] Stopped scheduled polling');
  }
}
