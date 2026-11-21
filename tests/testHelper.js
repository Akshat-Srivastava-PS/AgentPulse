import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { handleRequest } from '../src/server.js';

export function dispatchRequest({ method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const normHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      normHeaders[k.toLowerCase()] = String(v);
    }
    if (!normHeaders['host']) {
      normHeaders['host'] = 'localhost:3000';
    }

    const payloadStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (payloadStr && !normHeaders['content-type']) {
      normHeaders['content-type'] = 'application/json';
    }

    const req = new Readable({
      read() {
        if (payloadStr) {
          this.push(payloadStr);
        }
        this.push(null);
      }
    });

    req.method = method;
    req.url = url;
    req.headers = normHeaders;

    const res = new EventEmitter();
    res.headers = {};
    res.statusCode = 200;
    res.body = '';

    res.setHeader = (k, v) => {
      res.headers[k.toLowerCase()] = String(v);
    };

    res.getHeader = (k) => {
      return res.headers[k.toLowerCase()];
    };

    res.writeHead = (status, extraHeaders = {}) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(extraHeaders)) {
        res.setHeader(k, v);
      }
    };

    res.write = (chunk) => {
      res.body += chunk ? chunk.toString() : '';
    };

    res.end = (chunk) => {
      if (chunk) {
        res.body += chunk.toString();
      }

      const responseObj = {
        status: res.statusCode,
        headers: {
          get: (k) => res.headers[k.toLowerCase()]
        },
        text: async () => res.body,
        json: async () => JSON.parse(res.body)
      };

      resolve(responseObj);
    };

    handleRequest(req, res).catch(reject);
  });
}
