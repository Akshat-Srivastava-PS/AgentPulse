/**
 * agentpulse — a thin, zero-dependency JavaScript client for AgentPulse.
 *
 * Uses only the global `fetch` (Node 18+ / modern browsers / edge runtimes).
 * Every method is a thin wrapper over the public REST API, plus one MCP
 * JSON-RPC call for getMyImpact() (the manifest-wide impact verdict lives on
 * the MCP surface). If your agent framework speaks MCP natively you can use
 * the /mcp endpoint directly instead — this SDK is the plain-HTTP alternative
 * for agents and scripts that just want functions.
 *
 * Usage:
 *   import { AgentPulseClient, AgentPulseError } from 'agentpulse';
 *   const client = new AgentPulseClient({ baseUrl: 'https://agentpulse.dev', apiKey: 'agp_live_...' });
 *   const status = await client.getStatus('stripe');
 */

/**
 * Error thrown for any non-2xx AgentPulse response (and for MCP tool-level
 * errors surfaced by getMyImpact). Carries the HTTP `status` and the parsed
 * response `body` (an object when the server returned JSON, else raw text).
 */
export class AgentPulseError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'AgentPulseError';
    this.status = status;
    this.body = body;
  }
}

export class AgentPulseClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  AgentPulse origin, e.g. https://agentpulse.dev
   * @param {string} [options.apiKey] AgentPulse API key (agp_live_...). Required for
   *                                  manifest, webhook, telemetry, and impact calls;
   *                                  public reads (status, changes) work without it.
   * @param {Function} [options.fetch] fetch implementation override (defaults to globalThis.fetch).
   */
  constructor({ baseUrl, apiKey = null, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new TypeError('AgentPulseClient requires a baseUrl string, e.g. new AgentPulseClient({ baseUrl: "https://agentpulse.dev" })');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No fetch implementation available — use Node 18+ or pass { fetch } explicitly.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this._fetch = fetchImpl;
    /**
     * In-memory ETag cache for getStatus(): service slug -> { etag, body }.
     * Public for inspection; call clearStatusCache() to reset it.
     */
    this.statusCache = new Map();
  }

  clearStatusCache() {
    this.statusCache.clear();
  }

  _headers(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async _parseBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async _errorFrom(res) {
    const body = await this._parseBody(res);
    const message = (body && typeof body === 'object' && body.error) || `AgentPulse request failed with HTTP ${res.status}`;
    return new AgentPulseError(message, { status: res.status, body });
  }

  /** JSON request helper: returns the parsed body, throws AgentPulseError on non-2xx. */
  async _request(path, { method = 'GET', body = undefined } = {}) {
    const headers = this._headers();
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this._fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) throw await this._errorFrom(res);
    return this._parseBody(res);
  }

  /**
   * Compact status for one service (< 150 tokens from the server).
   * Honors the Good Citizen ETag protocol: the ETag of every 200 response is
   * cached in memory and sent as If-None-Match on the next call for the same
   * service; when the server answers 304, the cached body is returned as-is
   * (a 304 also consumes no daily quota server-side).
   */
  async getStatus(service) {
    const slug = String(service).toLowerCase();
    const cached = this.statusCache.get(slug);
    const headers = this._headers();
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    const res = await this._fetch(`${this.baseUrl}/v1/status/${encodeURIComponent(slug)}`, { headers });
    if (res.status === 304 && cached) {
      return cached.body;
    }
    if (!res.ok) throw await this._errorFrom(res);
    const data = await this._parseBody(res);
    const etag = typeof res.headers?.get === 'function' ? res.headers.get('etag') : null;
    if (etag) this.statusCache.set(slug, { etag, body: data });
    return data;
  }

  /**
   * Batch preflight verdict for a list of service slugs. When the client has
   * an API key and the agent has a stored dependency manifest, manifest
   * services in the list also carry an `impact` verdict.
   */
  async preflight(services = []) {
    return this._request('/v1/preflight', {
      method: 'POST',
      body: { dependencies: services }
    });
  }

  /**
   * Breaking-change delta feed.
   * @param {object} [options]
   * @param {string} [options.since] ISO 8601 checkpoint; only changes detected at/after it.
   * @param {'all'|'mine'} [options.scope] 'mine' restricts the feed to the caller's
   *                                       manifest services (requires an API key).
   * @param {string} [options.service] Optional single-service slug filter.
   * Each change carries a `playbook_url` for its migration playbook.
   */
  async getChanges({ since = null, scope = null, service = null } = {}) {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (scope) params.set('scope', scope);
    if (service) params.set('service', service);
    const qs = params.toString();
    return this._request(`/v1/changes${qs ? `?${qs}` : ''}`);
  }

  /** Full migration playbook for one breaking change (GET /v1/changes/:id/playbook). */
  async getPlaybook(changeId) {
    const data = await this._request(`/v1/changes/${encodeURIComponent(changeId)}/playbook`);
    return data.playbook;
  }

  /**
   * "Am I affected?" verdicts for every service in the caller's stored
   * dependency manifest. Backed by the MCP `get_my_impact` tool (JSON-RPC
   * over POST /mcp) — the one SDK method that uses the MCP surface, because
   * that is where the manifest-wide verdict lives. Requires an API key.
   */
  async getMyImpact() {
    const res = await this._fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_my_impact', arguments: {} }
      })
    });
    if (!res.ok) throw await this._errorFrom(res);
    const rpc = await this._parseBody(res);
    if (rpc?.error) {
      throw new AgentPulseError(rpc.error.message || 'MCP get_my_impact failed', { status: res.status, body: rpc.error });
    }
    const result = rpc?.result;
    const text = result?.content?.find(c => c.type === 'text')?.text;
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!result || result.isError || !parsed) {
      throw new AgentPulseError(
        (parsed && parsed.error) || 'MCP get_my_impact returned an error (an API key is required).',
        { status: res.status, body: parsed || rpc }
      );
    }
    return parsed;
  }

  /**
   * Replace-all write of the caller's dependency manifest.
   * @param {Array<{service: string, package?: string, version?: string}>} list
   * Requires an API key.
   */
  async setDependencies(list) {
    return this._request('/v1/agents/me/dependencies', {
      method: 'PUT',
      body: { dependencies: list }
    });
  }

  /** Read the caller's stored dependency manifest. Requires an API key. */
  async getDependencies() {
    return this._request('/v1/agents/me/dependencies');
  }

  /**
   * Create a webhook subscription.
   * @param {object} payload { url, events?, services? } — the response includes
   *                         the signing `secret`, shown only at creation.
   * Requires an API key.
   */
  async registerWebhook(payload) {
    return this._request('/v1/agents/me/webhooks', {
      method: 'POST',
      body: payload
    });
  }

  /**
   * Report an observed outage signal (crowdsourced telemetry).
   * @param {object} payload { service, endpoint, error_code, error_type? }
   * Requires an API key. Resolves with the 202 acceptance body.
   */
  async reportOutage(payload) {
    return this._request('/v1/telemetry/report', {
      method: 'POST',
      body: payload
    });
  }
}

export default AgentPulseClient;
