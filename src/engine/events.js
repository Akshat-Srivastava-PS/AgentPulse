/**
 * Domain event bus (Step 4: webhook alerts).
 *
 * A deliberately tiny, dependency-free EventEmitter that carries domain
 * events out of the storage layer. The DB helpers in src/db/index.js emit:
 *
 *   - 'incident.created'  -> the inserted incident row
 *   - 'incident.resolved' -> the incident row after resolution
 *   - 'change.detected'   -> the inserted breaking-change row
 *
 * Emitting from the DB helpers (rather than from each worker) means every
 * producer — synthetic ingestion, the Statuspage poller, the spec-diff
 * worker, and any future caller — raises each event exactly once, with no
 * per-caller wiring. The SSE broadcaster in src/workers/ingestion.js is a
 * separate, presentation-level stream and is intentionally not reused: it
 * only ever carried synthetic-ingestion incidents, never resolutions or
 * breaking changes.
 *
 * This module imports nothing, so db/index.js can depend on it without a
 * cycle; consumers (src/workers/webhooks.js) subscribe to it.
 */
import { EventEmitter } from 'node:events';

export const domainEvents = new EventEmitter();
domainEvents.setMaxListeners(50);

export const DOMAIN_EVENT_TYPES = ['incident.created', 'incident.resolved', 'change.detected'];
