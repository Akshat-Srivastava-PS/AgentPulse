/**
 * Statuspage Poller (Step 1: real ingestion)
 *
 * Polls Atlassian Statuspage-compatible `<base>/api/v2/summary.json` endpoints
 * for tracked vendors and maps live incidents into the AgentPulse incidents
 * model (source: 'statuspage').
 *
 * Dedupe: every Statuspage incident is stored under the deterministic primary
 * key `sp_<service_slug>_<statuspage_incident_id>`. Re-polling the same
 * incident is a no-op; when an incident disappears from the vendor's active
 * list, the local copy is resolved (which restores the service status when it
 * was the last active incident).
 *
 * Offline behaviour: any fetch/parse failure is logged and skipped. This
 * module never throws into the server or the scheduler.
 */
import {
  getService,
  getIncidentById,
  getActiveIncidents,
  createIncident,
  resolveIncident
} from '../db/index.js';
import { normalizeSeverity, generateAgentHint } from '../engine/normalizer.js';

/**
 * Service slug -> Atlassian Statuspage base URL.
 * Stripe is included behind the same generic mechanism: status.stripe.com is
 * Stripe's own status system, and if it does not answer with a
 * Statuspage-shaped summary payload the poll for that service is logged and
 * skipped like any other failure.
 * Override at runtime with STATUSPAGE_SOURCES_JSON, e.g.
 *   STATUSPAGE_SOURCES_JSON='{"openai":"https://status.openai.com"}'
 */
export const STATUSPAGE_REGISTRY = {
  openai: 'https://status.openai.com',
  anthropic: 'https://status.anthropic.com',
  github: 'https://www.githubstatus.com',
  stripe: 'https://status.stripe.com',
  supabase: 'https://status.supabase.com',
  vercel: 'https://www.vercel-status.com',
  cloudflare: 'https://www.cloudflarestatus.com',
  datadog: 'https://status.datadoghq.com',
  resend: 'https://status.resend.com',
  npm: 'https://status.npmjs.org',
  pinecone: 'https://status.pinecone.io',
  twilio: 'https://status.twilio.com',
  // Catalog expansion (Nov 2026): every base below was verified live —
  // <base>/api/v2/summary.json returned valid Statuspage summary JSON
  // before the vendor was added.
  discord: 'https://discordstatus.com',
  sentry: 'https://status.sentry.io',
  mongodb: 'https://status.mongodb.com',
  digitalocean: 'https://status.digitalocean.com',
  circleci: 'https://status.circleci.com',
  bitbucket: 'https://bitbucket.status.atlassian.com',
  zoom: 'https://status.zoom.us',
  cohere: 'https://status.cohere.com',
  clerk: 'https://status.clerk.com',
  render: 'https://status.render.com',
  flyio: 'https://status.flyio.net',
  snowflake: 'https://status.snowflake.com',
  elastic: 'https://status.elastic.co',
  postman: 'https://status.postman.com',
  shopify: 'https://www.shopifystatus.com',
  elevenlabs: 'https://status.elevenlabs.io',
  convex: 'https://status.convex.dev',
  // Held services added Nov 2026 (previously validated, held back):
  // each <base>/api/v2/summary.json was re-verified live before adding.
  linode: 'https://status.linode.com',
  atlassian: 'https://status.atlassian.com',
  jira: 'https://jira-software.status.atlassian.com',
  dropbox: 'https://status.dropbox.com',
  box: 'https://status.box.com',
  figma: 'https://status.figma.com',
  airtable: 'https://status.airtable.com'
};

export function getStatuspageRegistry() {
  const override = process.env.STATUSPAGE_SOURCES_JSON;
  if (!override) return { ...STATUSPAGE_REGISTRY };
  try {
    const parsed = JSON.parse(override);
    if (parsed && typeof parsed === 'object') return { ...parsed };
  } catch (err) {
    console.error('[StatuspagePoller] Invalid STATUSPAGE_SOURCES_JSON, using defaults:', err.message);
  }
  return { ...STATUSPAGE_REGISTRY };
}

/** Deterministic local incident id for a Statuspage incident (the dedupe key). */
export function statuspageIncidentId(serviceSlug, externalId) {
  const ext = String(externalId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `sp_${serviceSlug}_${ext}`.substring(0, 64);
}

function truncate(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.substring(0, max - 3) + '...' : clean;
}

/**
 * Pure mapping: one Statuspage incident object -> AgentPulse incident record.
 * Exported for offline unit tests.
 */
export function mapStatuspageIncident(serviceSlug, incident) {
  if (!incident || !incident.id) return null;

  const severity = normalizeSeverity(incident.impact || incident.status);
  const componentNames = (incident.components || [])
    .map(c => c && c.name)
    .filter(Boolean);
  const affectedScope = componentNames.length > 0
    ? componentNames.join(', ')
    : (incident.name || 'All components');

  const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : [];
  const latestBody = updates.length > 0 ? updates[0].body : '';
  const agentSummary = truncate(
    latestBody ? `${incident.name}: ${latestBody}` : `${incident.name} (${incident.status || 'investigating'})`,
    280
  );

  const agentHint = generateAgentHint({
    service: serviceSlug,
    scope: affectedScope,
    severity,
    summary: agentSummary
  });

  return {
    id: statuspageIncidentId(serviceSlug, incident.id),
    external_id: incident.id,
    source: 'statuspage',
    service_slug: serviceSlug,
    severity,
    affected_scope: truncate(affectedScope, 255),
    agent_summary: agentSummary,
    agent_hint: agentHint,
    status: incident.status || 'investigating',
    started_at: incident.created_at || incident.started_at || null
  };
}

/**
 * Pure mapping: a full Statuspage summary.json payload -> mapped active
 * incidents for the service. Statuspage's summary only lists unresolved
 * incidents, so everything returned here is active.
 * Exported for offline unit tests.
 */
export function mapStatuspageSummary(serviceSlug, summary) {
  if (!summary || typeof summary !== 'object') {
    return { incidents: [], indicator: null, description: null };
  }
  const rawIncidents = Array.isArray(summary.incidents) ? summary.incidents : [];
  const incidents = rawIncidents
    .filter(inc => inc && inc.status !== 'resolved' && inc.status !== 'postmortem')
    .map(inc => mapStatuspageIncident(serviceSlug, inc))
    .filter(Boolean);

  return {
    incidents,
    indicator: summary.status?.indicator || null,
    description: summary.status?.description || null
  };
}

/**
 * Applies a fetched summary payload to the DB: creates new incidents, skips
 * ones already stored (dedupe by deterministic id), and resolves local
 * Statuspage incidents that the vendor no longer lists as active.
 */
export function applyStatuspageSummary(serviceSlug, summary) {
  const result = { service: serviceSlug, created: 0, skipped: 0, resolved: 0 };
  if (!getService(serviceSlug)) {
    result.skipped_service = true;
    return result;
  }

  const { incidents } = mapStatuspageSummary(serviceSlug, summary);
  const activeIds = new Set(incidents.map(i => i.id));

  for (const mapped of incidents) {
    if (getIncidentById(mapped.id)) {
      result.skipped++;
      continue;
    }
    createIncident({
      id: mapped.id,
      service_slug: serviceSlug,
      severity: mapped.severity,
      affected_scope: mapped.affected_scope,
      agent_summary: mapped.agent_summary,
      agent_hint: mapped.agent_hint
    });
    result.created++;
  }

  // Resolve local Statuspage incidents the vendor no longer reports active.
  const prefix = `sp_${serviceSlug}_`;
  for (const active of getActiveIncidents(serviceSlug)) {
    if (active.id.startsWith(prefix) && !activeIds.has(active.id)) {
      resolveIncident(active.id);
      result.resolved++;
    }
  }

  return result;
}

async function fetchJson(url, fetchImpl, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AgentPulse-Statuspage-Poller/1.0', 'Accept': 'application/json' }
    });
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Polls one service. Never throws; returns null on any failure. */
export async function pollStatuspageService(serviceSlug, fetchImpl = globalThis.fetch) {
  const registry = getStatuspageRegistry();
  const base = registry[serviceSlug];
  if (!base) return null;
  if (!getService(serviceSlug)) return null; // e.g. twilio until it is catalogued

  const url = `${base.replace(/\/$/, '')}/api/v2/summary.json`;
  try {
    const summary = await fetchJson(url, fetchImpl);
    const result = applyStatuspageSummary(serviceSlug, summary);
    if (result.created > 0 || result.resolved > 0) {
      console.log(`[StatuspagePoller] ${serviceSlug}: ${result.created} new, ${result.resolved} resolved, ${result.skipped} unchanged`);
    }
    return result;
  } catch (err) {
    console.warn(`[StatuspagePoller] ${serviceSlug} poll failed (skipping): ${err.message}`);
    return null;
  }
}

/** Polls every registered service sequentially. Never throws. */
export async function pollAllStatuspages(fetchImpl = globalThis.fetch) {
  const results = [];
  for (const slug of Object.keys(getStatuspageRegistry())) {
    const result = await pollStatuspageService(slug, fetchImpl);
    if (result) results.push(result);
  }
  return results;
}

// --- Scheduler wiring (started/stopped by the ingestion worker) ---

let pollerInterval = null;

export function startStatuspagePoller(intervalMs = 300000) {
  if (pollerInterval) return;
  console.log(`[StatuspagePoller] Started scheduled polling every ${Math.round(intervalMs / 1000)}s`);
  setTimeout(() => { pollAllStatuspages().catch(() => {}); }, 5000);
  pollerInterval = setInterval(() => {
    pollAllStatuspages().catch(err => console.warn('[StatuspagePoller] Cycle failed:', err.message));
  }, intervalMs);
}

export function stopStatuspagePoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[StatuspagePoller] Stopped scheduled polling');
  }
}
