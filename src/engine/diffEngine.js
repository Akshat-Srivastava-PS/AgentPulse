import crypto from 'node:crypto';
import { getService, getActiveIncidents, getBreakingChanges, getAllServices, getAgentDependencies } from '../db/index.js';
import { formatCompactStatusPayload, estimateTokenCount } from './normalizer.js';
import { changeMatchesEndpoints } from './endpoints.js';

export function computeIncidentFingerprint(serviceSlug, scope, summary) {
  const norm = `${serviceSlug}:${(scope || '').trim().toLowerCase()}:${(summary || '').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').substring(0, 16);
}

// --- "Affected code" impact evaluation (Step 2) ---

/** A breaking change counts against a dependency for 90 days after detection. */
export const BREAKING_CHANGE_IMPACT_WINDOW_DAYS = 90;

function truncate(text, max = 90) {
  const s = String(text || '').trim();
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

/**
 * Compact affected verdict for one service: affected iff it has any active
 * incident OR any breaking change detected within the impact window.
 * When `endpoints` are declared for the dependency, only breaking changes
 * on matching operations count (incidents are service-level and always
 * count); with no endpoints the verdict is purely service-level, as before.
 * Returns matching ids plus a one-line reason (kept short for token budget).
 */
export function evaluateServiceImpact(serviceSlug, endpoints = null) {
  const slug = String(serviceSlug || '').trim().toLowerCase();
  const incidents = getActiveIncidents(slug);
  const windowStart = new Date(Date.now() - BREAKING_CHANGE_IMPACT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const changes = getBreakingChanges(slug, windowStart)
    .filter(c => changeMatchesEndpoints(c, endpoints));

  const incident_ids = incidents.map(i => i.id);
  const change_ids = changes.map(c => c.id);
  const affected = incident_ids.length > 0 || change_ids.length > 0;

  let reason = `No active incidents or breaking changes in the last ${BREAKING_CHANGE_IMPACT_WINDOW_DAYS} days.`;
  if (incidents.length > 0) {
    reason = `Active ${incidents[0].severity} incident ${incidents[0].id} on ${slug}: ${truncate(incidents[0].agent_summary)}`;
  } else if (changes.length > 0) {
    reason = `Breaking change ${changes[0].id} (${changes[0].change_type}) detected ${String(changes[0].detected_at).substring(0, 10)}: ${truncate(changes[0].diff_summary)}`;
  }

  return { affected, incident_ids, change_ids, reason };
}

/**
 * Impact verdicts for every entry in an agent's stored dependency manifest.
 */
export function evaluateManifestImpact(agentId) {
  const manifest = getAgentDependencies(agentId);
  const dependencies = manifest.map(dep => ({
    ...dep,
    impact: evaluateServiceImpact(dep.service, dep.endpoints)
  }));
  const affectedDeps = dependencies.filter(d => d.impact.affected);

  return {
    manifest_count: dependencies.length,
    affected_count: affectedDeps.length,
    affected_services: affectedDeps.map(d => d.service),
    dependencies
  };
}

/**
 * Evaluates dependency health for batch preflight check
 * Used by POST /v1/preflight and MCP check_dependency_health tool.
 * When `agentId` is provided and that agent has a stored dependency manifest,
 * each requested service that is in the manifest gains a compact `impact`
 * (affected) verdict; unauthenticated/no-manifest calls are unchanged.
 */
export function evaluatePreflight(dependencies = [], agentId = null) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    return {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      dependencies_count: 0,
      healthy: true,
      degraded_count: 0,
      outage_count: 0,
      message: 'No dependencies specified. Safe to proceed.',
      services: {}
    };
  }

  const normalizedSlugs = dependencies.map(d => String(d).trim().toLowerCase());
  const serviceResults = {};
  let degradedCount = 0;
  let outageCount = 0;
  const criticalHints = [];

  for (const slug of normalizedSlugs) {
    const service = getService(slug);
    if (!service) {
      serviceResults[slug] = {
        status: 'unknown',
        tracked: false,
        message: `Service '${slug}' is not currently monitored by AgentPulse. Proceed with local error-handling.`
      };
      continue;
    }

    const activeIncidents = getActiveIncidents(slug);
    const breaking = getBreakingChanges(slug);
    const compact = formatCompactStatusPayload(service, activeIncidents, breaking);

    if (service.current_status === 'outage') {
      outageCount++;
      const primaryHint = activeIncidents[0]?.agent_hint || `Service ${service.name} is experiencing an outage.`;
      criticalHints.push(`${slug}: ${primaryHint}`);
    } else if (service.current_status === 'degraded') {
      degradedCount++;
      const primaryHint = activeIncidents[0]?.agent_hint || `Service ${service.name} is degraded.`;
      criticalHints.push(`${slug}: ${primaryHint}`);
    }

    serviceResults[slug] = {
      status: service.current_status,
      tracked: true,
      latency_ms: service.latency_ms,
      active_incidents_count: activeIncidents.length,
      compact
    };
  }

  let verdict = 'pass';
  let recommendation = 'All dependencies operational. Safe to execute workflow.';

  if (outageCount > 0) {
    verdict = 'block';
    recommendation = `CRITICAL: ${outageCount} dependency in outage state. Recommended action: Halt tool execution. Details: ${criticalHints.join(' | ')}`;
  } else if (degradedCount > 0) {
    verdict = 'degraded';
    recommendation = `WARNING: ${degradedCount} dependency degraded. Recommended action: ${criticalHints.join(' | ')}`;
  }

  const responsePayload = {
    verdict,
    healthy: verdict === 'pass',
    checked_at: new Date().toISOString(),
    total_requested: dependencies.length,
    outage_count: outageCount,
    degraded_count: degradedCount,
    recommendation,
    services: serviceResults
  };

  // Step 2 enrichment: for an authenticated caller with a stored manifest,
  // attach an `impact` (affected) verdict to each requested service that is
  // in the manifest. Compact by design — ids + one-line reason only.
  if (agentId) {
    const manifest = getAgentDependencies(agentId);
    if (manifest.length > 0) {
      const manifestBySlug = new Map(manifest.map(d => [d.service, d]));
      let affectedCount = 0;
      for (const slug of normalizedSlugs) {
        const entry = serviceResults[slug];
        if (entry && entry.tracked && manifestBySlug.has(slug)) {
          entry.impact = evaluateServiceImpact(slug, manifestBySlug.get(slug).endpoints);
          if (entry.impact.affected) affectedCount++;
        }
      }
      responsePayload.affected_count = affectedCount;
    }
  }

  // Estimate tokens to ensure preflight returns sub-250 token payload
  responsePayload._meta = {
    estimated_tokens: estimateTokenCount(responsePayload),
    cached_etag_support: true
  };

  return responsePayload;
}
