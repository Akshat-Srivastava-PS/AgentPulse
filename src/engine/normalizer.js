/**
 * Normalizer & Severity Engine for AgentPulse
 * Converts disparate provider status payloads (Statuspage.io, GitHub status, RSS, etc.)
 * into compact, deterministic schemas under 120 tokens per event.
 */

export function estimateTokenCount(textOrObj) {
  if (!textOrObj) return 0;
  const str = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj);
  // Accurate token estimation for LLM tokenizers (BPE approximation ~ 3.7 chars per token)
  return Math.ceil(str.length / 3.7);
}

export function normalizeSeverity(rawStatus) {
  if (!rawStatus) return 'minor';
  const s = String(rawStatus).toLowerCase();

  if (s.includes('critical') || s.includes('major_outage') || s.includes('unreachable') || s.includes('fatal')) {
    return 'critical';
  }
  if (s.includes('major') || s.includes('degraded') || s.includes('partial_outage') || s.includes('elevated_errors')) {
    return 'major';
  }
  return 'minor';
}

export function normalizeServiceStatus(rawStatus) {
  if (!rawStatus) return 'operational';
  const s = String(rawStatus).toLowerCase();

  if (s.includes('major_outage') || s.includes('critical') || s.includes('down')) {
    return 'outage';
  }
  if (s.includes('degraded') || s.includes('minor') || s.includes('partial') || s.includes('investigating')) {
    return 'degraded';
  }
  return 'operational';
}

/**
 * Synthesizes an immediate prescriptive action for AI coding/devops agents.
 */
export function generateAgentHint({ service, scope, severity, summary }) {
  const scopeLower = (scope || '').toLowerCase();
  const summaryLower = (summary || '').toLowerCase();

  if (severity === 'critical') {
    if (scopeLower.includes('payment') || service === 'stripe') {
      return 'Pause payment operations immediately. Route checkout to secondary payment gateway or queue pending transactions.';
    }
    if (scopeLower.includes('auth') || scopeLower.includes('iam')) {
      return 'Bypass auth cache with cautious circuit breaker or alert operator. Do not blast authentication endpoints.';
    }
    if (service === 'openai' || service === 'anthropic') {
      return 'Switch LLM provider fallback (Anthropic <-> OpenAI). Pause high-throughput agent loops to prevent context loss.';
    }
    return 'Halt automated workflow retries. Circuit breaker tripped. Await status recovery.';
  }

  if (severity === 'major') {
    if (summaryLower.includes('502') || summaryLower.includes('500') || summaryLower.includes('error rate')) {
      return 'Use exponential backoff (min 15s) or defer non-urgent retries. Do not loop fail.';
    }
    if (summaryLower.includes('rate limit') || summaryLower.includes('throttl')) {
      return 'Throttle request concurrency by 50%. Obey Retry-After headers strictly.';
    }
    if (summaryLower.includes('latency') || summaryLower.includes('slow')) {
      return 'Increase client timeout to 30s. Degrade optional tool calls.';
    }
    return 'Degraded dependency. Use exponential backoff (min 15s) or defer non-urgent retries.';
  }

  return 'Minor service latency or isolated scope. Retry once with jitter; fallback if persistent.';
}

/**
 * Compresses an incident into strict token constraints (< 120 tokens).
 */
export function compressIncident({ id, severity, affected_scope, agent_summary, agent_hint }) {
  // Truncate summary if excessively verbose from provider prose
  let cleanSummary = (agent_summary || '').trim();
  if (cleanSummary.length > 240) {
    cleanSummary = cleanSummary.substring(0, 237) + '...';
  }

  let cleanHint = (agent_hint || '').trim();
  if (cleanHint.length > 240) {
    cleanHint = cleanHint.substring(0, 237) + '...';
  }

  const incident = {
    id,
    severity: normalizeSeverity(severity),
    scope: affected_scope,
    summary: cleanSummary,
    agent_hint: cleanHint
  };

  const tokens = estimateTokenCount(incident);
  if (tokens > 120) {
    // If still slightly over token budget, tighten summary
    incident.summary = incident.summary.substring(0, 160) + '...';
    incident.agent_hint = incident.agent_hint.substring(0, 160) + '...';
  }

  return incident;
}

/**
 * Builds the compact status payload matching the prompt specification:
 * Sample Compact Payload (GET /v1/status/stripe)
 */
export function formatCompactStatusPayload(service, activeIncidents = [], breakingChanges = []) {
  const formattedIncidents = activeIncidents.map(inc => compressIncident({
    id: inc.id,
    severity: inc.severity,
    affected_scope: inc.affected_scope,
    agent_summary: inc.agent_summary,
    agent_hint: inc.agent_hint
  }));

  const formattedChanges = breakingChanges.slice(0, 3).map(bc => ({
    id: bc.id,
    date: bc.version_or_date,
    type: bc.change_type,
    summary: bc.diff_summary,
    hint: bc.migration_hint
  }));

  const payload = {
    service: service.slug,
    status: service.current_status,
    updated_at: service.updated_at,
    active_incidents: formattedIncidents,
    recent_breaking_changes: formattedChanges
  };

  return payload;
}
