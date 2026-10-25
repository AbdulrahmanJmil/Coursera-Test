import { BUILD } from './build-config.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Calls the RoundLedger backend. Network failures become ApiError(0, 'OFFLINE'). */
export async function api(path, { method = 'GET', body, token, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(BUILD.backendUrl + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'omit',
    });
  } catch (err) {
    throw new ApiError(0, err.name === 'AbortError' ? 'TIMEOUT' : 'OFFLINE', err.name === 'AbortError' ? 'The server took too long to respond.' : 'Cannot reach the RoundLedger server.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'HTTP_' + res.status, e.message || `Server error (${res.status}).`, e.details);
  }
  return json;
}
