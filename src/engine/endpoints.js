/**
 * Endpoint Matching (endpoint-level relevance)
 *
 * A dependency-manifest entry may optionally declare the specific API
 * endpoints the agent actually calls on a service, e.g.
 *   "GET /v1/charges"   — one operation (method + path)
 *   "/v1/charges"       — any method on that path
 *
 * When a dependency declares endpoints, only breaking changes on matching
 * operations count toward that dependency's impact verdict, its
 * `scope=mine` change feed, and its `change.detected` webhook deliveries.
 * Dependencies without endpoints keep the original service-level behaviour.
 *
 * Matching rule (kept deliberately simple):
 *   - the method must match when the declaration names one (a change whose
 *     location carries no method — e.g. a removed path — is matched on
 *     path alone);
 *   - the change's operation path must equal the declared path, or sit
 *     under it (declared path + '/'), so "/v1/charges" also covers
 *     "/v1/charges/{id}" and "/v1/charges/{id}/refunds";
 *   - a change with NO recorded location (rows persisted before structured
 *     kind/location existed) always matches — endpoint filtering never
 *     silently drops history.
 */

export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * Normalizes one declared endpoint entry to "METHOD /path" or "/path".
 * Returns null when the entry is not a usable endpoint string.
 */
export function parseEndpointEntry(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  let method = null;
  let path;
  if (parts.length === 1) {
    [path] = parts;
  } else if (parts.length === 2) {
    method = parts[0].toUpperCase();
    path = parts[1];
    if (!HTTP_METHODS.has(method)) return null;
  } else {
    return null;
  }

  if (!path.startsWith('/')) return null;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return method ? `${method} ${path}` : path;
}

/**
 * Normalizes a declared endpoints list: valid entries are normalized and
 * deduped (order preserved). Returns null for null/undefined input, and an
 * array (possibly empty) otherwise; invalid entries are dropped here —
 * the REST layer validates strictly and rejects them with 400 first.
 */
export function normalizeEndpoints(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of input) {
    const normalized = parseEndpointEntry(entry);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Extracts the operation ({ method, path }) from a spec-diff location
 * string: "GET /v1/charges response property customer.email" ->
 * { method: 'GET', path: '/v1/charges' }; a bare-path location
 * ("/v1/charges", used for removed/added paths) -> { method: null, path }.
 * Returns null when no operation can be identified.
 */
export function parseLocationOperation(location) {
  if (!location || typeof location !== 'string') return null;
  const s = location.trim();
  if (!s) return null;
  if (s.startsWith('/')) {
    return { method: null, path: s.split(/\s+/)[0] };
  }
  const m = s.match(/^([A-Za-z]+)\s+(\/\S+)/);
  if (!m) return null;
  const method = m[1].toUpperCase();
  if (!HTTP_METHODS.has(method)) return null;
  return { method, path: m[2] };
}

/**
 * True when a breaking-change row is relevant to a dependency declaring
 * `endpoints` (see the module header for the matching rule). No declared
 * endpoints (null/empty) = service-level relevance, always true.
 */
export function changeMatchesEndpoints(change, endpoints) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) return true;
  const op = parseLocationOperation(change && change.location);
  if (!op) return true; // legacy row without a recorded location: still counts

  return endpoints.some(declaredRaw => {
    const declared = parseLocationOperation(parseEndpointEntry(declaredRaw));
    if (!declared) return false;
    if (declared.method && op.method && declared.method !== op.method) return false;
    return op.path === declared.path || op.path.startsWith(declared.path + '/');
  });
}
