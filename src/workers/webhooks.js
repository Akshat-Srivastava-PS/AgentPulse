/**
 * Webhook Dispatcher (Step 4: webhook alerts)
 *
 * Subscribes to the domain event bus (src/engine/events.js), which the DB
 * helpers feed from createIncident / resolveIncident / createBreakingChange.
 * That is the single choke point every producer passes through — synthetic
 * ingestion, the Statuspage poller, and the spec-diff worker — so each event
 * is dispatched exactly once with no per-worker wiring. (The SSE
 * eventBroadcaster was not reused: it only ever carried synthetic-ingestion
 * incidents, never resolutions or breaking changes.)
 *
 * For each event, every active webhook whose event filter includes the type
 * and whose service filter matches (null/empty filter = all services) gets
 * one delivery row in webhook_deliveries and an async POST. For
 * change.detected, delivery is additionally narrowed by the webhook owner's
 * dependency manifest: when the owner declared endpoints for the service,
 * only changes on matching operations are delivered (see
 * src/engine/endpoints.js for the matching rule).
 *
 *   Body (raw JSON, signed as-is):
 *     { "id": <delivery id>, "type": <event type>,
 *       "created_at": <iso>, "data": <incident|breaking-change row> }
 *   Headers:
 *     X-AgentPulse-Event:     <event type>
 *     X-AgentPulse-Delivery:  <delivery id>
 *     X-AgentPulse-Signature: sha256=<HMAC-SHA256 hex of the raw body,
 *                              keyed with the webhook's secret>
 *
 * Delivery policy: 5s per-attempt timeout (WEBHOOK_TIMEOUT_MS), up to 3
 * attempts total with backoff delays from WEBHOOK_RETRY_DELAYS_MS
 * (comma-separated ms, default "1000,5000" => attempts at 0s, +1s, +5s).
 * 2xx = delivered; anything else (or a network error/timeout) is retried
 * and finally recorded as failed with the last status code / error.
 * Delivery runs fully async and is wrapped so it can never throw into —
 * or block — the request/ingestion path that raised the event.
 */
import crypto from 'node:crypto';
import { domainEvents, DOMAIN_EVENT_TYPES } from '../engine/events.js';
import {
  getDb,
  getMatchingWebhooks,
  createWebhookDelivery,
  updateWebhookDelivery
} from '../db/index.js';

export const WEBHOOK_EVENT_TYPES = DOMAIN_EVENT_TYPES;

const inFlight = new Set();
let started = false;

function getRetryDelaysMs() {
  const raw = process.env.WEBHOOK_RETRY_DELAYS_MS;
  if (!raw) return [1000, 5000];
  const parsed = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : [1000, 5000];
}

function getTimeoutMs() {
  const n = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

export function signWebhookPayload(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function attemptDelivery(webhook, deliveryId, eventType, rawBody) {
  const delays = getRetryDelaysMs();
  const maxAttempts = delays.length + 1;
  let attempts = 0;
  let lastStatusCode = null;
  let lastError = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
      let res;
      try {
        res = await fetch(webhook.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'AgentPulse-Webhooks/1.0',
            'X-AgentPulse-Event': eventType,
            'X-AgentPulse-Delivery': deliveryId,
            'X-AgentPulse-Signature': signWebhookPayload(webhook.secret, rawBody)
          },
          body: rawBody
        });
      } finally {
        clearTimeout(timeout);
      }

      lastStatusCode = res.status;
      // Drain the body so the socket can be reused/closed cleanly.
      try { await res.text(); } catch { /* ignore */ }

      if (res.status >= 200 && res.status < 300) {
        updateWebhookDelivery(deliveryId, {
          status: 'delivered',
          attempts,
          last_status_code: lastStatusCode,
          last_error: null,
          delivered_at: new Date().toISOString()
        });
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastStatusCode = null;
      lastError = err.name === 'AbortError' ? `Timed out after ${getTimeoutMs()}ms` : err.message;
    }

    if (attempts < maxAttempts) {
      updateWebhookDelivery(deliveryId, {
        status: 'pending',
        attempts,
        last_status_code: lastStatusCode,
        last_error: lastError
      });
      await sleep(delays[attempts - 1]);
    }
  }

  updateWebhookDelivery(deliveryId, {
    status: 'failed',
    attempts,
    last_status_code: lastStatusCode,
    last_error: lastError
  });
}

/**
 * Fans one domain event out to all matching webhooks. Synchronous up to the
 * point where each delivery is recorded and its async attempt loop is
 * started, so callers (and tests, via flushWebhookDeliveries) can rely on
 * the delivery rows existing as soon as the raising call returns.
 * Never throws.
 */
export function dispatchWebhookEvent(eventType, data) {
  try {
    if (!data || !data.service_slug) return;
    const webhooks = getMatchingWebhooks(eventType, data.service_slug, eventType === 'change.detected' ? data : null);
    for (const webhook of webhooks) {
      const delivery = createWebhookDelivery({ webhook_id: webhook.id, event_type: eventType, payload: '' });
      const rawBody = JSON.stringify({
        id: delivery.id,
        type: eventType,
        created_at: delivery.created_at,
        data
      });
      // Store the exact signed bytes on the delivery row for audit/replay.
      persistPayload(delivery.id, rawBody);

      const promise = attemptDelivery(webhook, delivery.id, eventType, rawBody)
        .catch(err => console.error(`[Webhooks] Delivery ${delivery.id} crashed:`, err.message))
        .finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }
  } catch (err) {
    console.error('[Webhooks] Dispatch failed:', err.message);
  }
}

// The deliveries table stores the exact payload bytes that were signed;
// updateWebhookDelivery intentionally does not touch the payload column, so
// payload persistence lives here.
function persistPayload(deliveryId, rawBody) {
  try {
    getDb().prepare('UPDATE webhook_deliveries SET payload = ? WHERE id = ?').run(rawBody, deliveryId);
  } catch (err) {
    console.error('[Webhooks] Could not persist payload:', err.message);
  }
}

/** Resolves when every delivery started so far has reached a final state. */
export async function flushWebhookDeliveries() {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/** Idempotent subscription to the domain event bus. */
export function startWebhookDispatcher() {
  if (started) return;
  started = true;
  for (const type of DOMAIN_EVENT_TYPES) {
    domainEvents.on(type, data => dispatchWebhookEvent(type, data));
  }
  console.log('[Webhooks] Dispatcher subscribed to domain events (incident.created, incident.resolved, change.detected)');
}
