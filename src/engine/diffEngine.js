import crypto from 'node:crypto';
import { getService, getActiveIncidents, getBreakingChanges, getAllServices } from '../db/index.js';
import { formatCompactStatusPayload, estimateTokenCount } from './normalizer.js';

export function computeIncidentFingerprint(serviceSlug, scope, summary) {
  const norm = `${serviceSlug}:${(scope || '').trim().toLowerCase()}:${(summary || '').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').substring(0, 16);
}

/**
 * Evaluates dependency health for batch preflight check
 * Used by POST /v1/preflight and MCP check_dependency_health tool
 */
export function evaluatePreflight(dependencies = []) {
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

  // Estimate tokens to ensure preflight returns sub-250 token payload
  responsePayload._meta = {
    estimated_tokens: estimateTokenCount(responsePayload),
    cached_etag_support: true
  };

  return responsePayload;
}
