/**
 * Telemetry Feedback Loop (Step 2: closing the loop on crowdsourced signals)
 *
 * Agents report runtime failures via MCP `report_outage_signal` and REST
 * `POST /v1/telemetry/report`; those rows land in `outage_signals` through
 * `recordOutageSignal()`. This module is the consumer the audit called for:
 * after each recorded signal it aggregates the recent reports for that
 * service, and when a cluster crosses the trigger threshold it runs an
 * out-of-cycle spec re-check (`pollSpecService`, already hash-gated, so an
 * unchanged spec costs one fetch and no diff work).
 *
 * If the re-check finds the published spec UNCHANGED (same hash) while
 * agents are reporting clustered failures, the behaviour changed but the
 * spec didn't — a silently tightened rate limit, a changed error shape, a
 * behaviour drift no contract diff can see. That condition is raised as ONE
 * incident through the existing `createIncident()` plumbing, so it flows
 * through the normal domain events, webhooks, and preflight verdicts.
 *
 * Guard rails:
 *  - Only services present in the spec registry can be re-checked; anything
 *    else is a quiet no-op (signals are still recorded).
 *  - A per-service cooldown (in-memory, like the pollers' module state)
 *    caps re-checks so a report storm cannot become a fetch storm, and an
 *    already-active behaviour incident suppresses duplicates.
 *  - Evaluation is fire-and-forget from the request path and never throws:
 *    a loop failure must never break signal recording or the 202 response.
 *
 * Trigger tuning is env-configurable:
 *   TELEMETRY_TRIGGER_MIN_SIGNALS   (default 5)
 *   TELEMETRY_TRIGGER_MIN_AGENTS    (default 3 distinct agents)
 *   TELEMETRY_TRIGGER_WINDOW_MS     (default 900000 = 15 minutes)
 *   TELEMETRY_TRIGGER_COOLDOWN_MS   (default 900000 = 15 minutes)
 */
import { getRecentOutageSignalStats, getActiveIncidents, createIncident } from '../db/index.js';
import { getSpecRegistry, pollSpecService } from './specDiff.js';
import { generateAgentHint } from '../engine/normalizer.js';

/** Marker phrase carried by behaviour-changed incidents (dedupe + search). */
export const BEHAVIOUR_CHANGED_MARKER = "Behaviour changed, spec didn't";

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTelemetryLoopConfig(env = process.env) {
  return {
    minSignals: parsePositiveInt(env.TELEMETRY_TRIGGER_MIN_SIGNALS, 5),
    minDistinctAgents: parsePositiveInt(env.TELEMETRY_TRIGGER_MIN_AGENTS, 3),
    windowMs: parsePositiveInt(env.TELEMETRY_TRIGGER_WINDOW_MS, 15 * 60 * 1000),
    cooldownMs: parsePositiveInt(env.TELEMETRY_TRIGGER_COOLDOWN_MS, 15 * 60 * 1000)
  };
}

// Per-service cooldown state: serviceSlug -> epoch ms of the last trigger.
const lastTriggerAtByService = new Map();

/** Test hook: clears the in-memory cooldown state. */
export function resetTelemetryLoopState() {
  lastTriggerAtByService.clear();
}

function hasActiveBehaviourIncident(serviceSlug, getActiveIncidentsImpl) {
  return getActiveIncidentsImpl(serviceSlug)
    .some(incident => typeof incident.agent_summary === 'string'
      && incident.agent_summary.includes(BEHAVIOUR_CHANGED_MARKER));
}

/**
 * Evaluates the telemetry trigger for one service. Injectable dependencies
 * (config, registry, stats reader, poll function, incident plumbing) keep
 * the loop unit-testable offline. Never throws; the returned object
 * describes the outcome:
 *   { triggered: false, reason: 'not_in_spec_registry' | 'below_threshold'
 *       | 'cooldown' | 'error', stats? }
 *   { triggered: true, rechecked: true, spec_changed, incident_created,
 *     incident?, stats }
 */
export async function evaluateTelemetryTrigger(serviceSlug, deps = {}) {
  const result = { service: serviceSlug, triggered: false };
  try {
    const config = deps.config || getTelemetryLoopConfig();
    const registry = (deps.getSpecRegistry || getSpecRegistry)();
    if (!registry || !registry[serviceSlug]) {
      result.reason = 'not_in_spec_registry';
      return result;
    }

    const statsFn = deps.getSignalStats || getRecentOutageSignalStats;
    const sinceIso = new Date(Date.now() - config.windowMs).toISOString();
    const stats = statsFn(serviceSlug, sinceIso);
    result.stats = stats;

    if (!stats || stats.total < config.minSignals || stats.distinct_agents < config.minDistinctAgents) {
      result.reason = 'below_threshold';
      return result;
    }

    const now = Date.now();
    const lastTriggerAt = lastTriggerAtByService.get(serviceSlug) || 0;
    if (now - lastTriggerAt < config.cooldownMs) {
      result.reason = 'cooldown';
      return result;
    }
    // Claim the cooldown slot before the async re-check so concurrent
    // evaluations for the same service cannot storm the provider.
    lastTriggerAtByService.set(serviceSlug, now);
    result.triggered = true;

    const poll = deps.pollSpecService || pollSpecService;
    const pollResult = await poll(serviceSlug);
    result.rechecked = Boolean(pollResult);
    if (!pollResult) {
      result.reason = 'recheck_failed';
      return result;
    }

    result.spec_changed = Boolean(pollResult.changed);
    result.incident_created = false;

    // Spec changed: any breaking changes already flowed through
    // change.detected events inside the poller. Nothing more to raise.
    // Baseline (first-ever fetch) proves nothing about behaviour either.
    if (pollResult.changed || pollResult.baseline) {
      return result;
    }

    // Spec unchanged (same hash) while failures cluster: behaviour changed,
    // spec didn't. Raise it once — an active twin suppresses duplicates.
    const getActive = deps.getActiveIncidents || getActiveIncidents;
    if (hasActiveBehaviourIncident(serviceSlug, getActive)) {
      result.reason = 'incident_already_active';
      return result;
    }

    const windowMinutes = Math.max(1, Math.round(config.windowMs / 60000));
    const summary = `${BEHAVIOUR_CHANGED_MARKER}: ${stats.total} agent-reported failures from ${stats.distinct_agents} distinct agents in the last ${windowMinutes} minutes, but an out-of-cycle re-check found the published ${serviceSlug} OpenAPI spec unchanged (same hash). The failures are real at runtime but invisible in the published contract — consistent with a silent provider behaviour change such as a tightened rate limit or a changed error shape.`;
    const create = deps.createIncident || createIncident;
    const incident = create({
      service_slug: serviceSlug,
      severity: 'major',
      affected_scope: `${serviceSlug} API behaviour (agent-reported failures)`,
      agent_summary: summary,
      agent_hint: generateAgentHint({
        service: serviceSlug,
        scope: `${serviceSlug} API behaviour`,
        severity: 'major',
        summary
      })
    });
    result.incident_created = true;
    result.incident = incident;
    console.log(`[TelemetryLoop] ${serviceSlug}: behaviour-changed incident raised (${incident.id}) — ${stats.total} signals / ${stats.distinct_agents} agents, spec unchanged`);
    return result;
  } catch (err) {
    console.warn(`[TelemetryLoop] Evaluation failed for ${serviceSlug} (signals unaffected): ${err.message}`);
    result.reason = 'error';
    result.error = err.message;
    return result;
  }
}

/**
 * Fire-and-forget evaluation hook for the signal-recording paths (MCP +
 * REST). Schedules the evaluation off the request path and swallows every
 * failure: recording a signal must never block on, or be broken by, the loop.
 */
export function scheduleTelemetryEvaluation(serviceSlug, deps = {}) {
  try {
    Promise.resolve()
      .then(() => evaluateTelemetryTrigger(serviceSlug, deps))
      .catch(err => console.warn(`[TelemetryLoop] Scheduled evaluation failed for ${serviceSlug}: ${err.message}`));
  } catch (err) {
    console.warn(`[TelemetryLoop] Could not schedule evaluation for ${serviceSlug}: ${err.message}`);
  }
}
