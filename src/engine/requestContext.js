import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request logging context (owner visibility).
 *
 * server.js creates one context object per HTTP request and runs the
 * request handler inside this AsyncLocalStorage store. The object is
 * shared by reference across the whole request lifecycle:
 *
 *   {
 *     shouldLog: boolean,  // /v1/* (except /v1/admin/*) and MCP tools/call
 *     logged:    boolean,  // set once the request_log row has been written
 *     agentId:   string|null,
 *     agentName: string|null,
 *     counted:   0|1       // flipped by recordAgentUsage when quota is consumed
 *   }
 *
 * The DB layer (recordAgentUsage) and the MCP quota gate run deep inside
 * the handler, far from the response lifecycle; they use this context to
 * attribute the request and mark it counted, while server.js writes the
 * single request_log row when the response ends. Because there is exactly
 * one context per request and the write is guarded by `logged`, a request
 * is never logged twice.
 */
export const requestLogContext = new AsyncLocalStorage();

export function getRequestLogContext() {
  return requestLogContext.getStore() || null;
}
