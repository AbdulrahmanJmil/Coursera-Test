import { badRequest } from './http.js';

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function str(body, key, { required = true, min = 0, max = 500, pattern, trim = true } = {}) {
  let v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${key} is required`, { field: key });
    return undefined;
  }
  if (typeof v !== 'string') throw badRequest(`${key} must be a string`, { field: key });
  if (trim) v = v.trim();
  if (v.length < min || v.length > max) throw badRequest(`${key} must be ${min}–${max} characters`, { field: key });
  if (pattern && !pattern.test(v)) throw badRequest(`${key} has an invalid format`, { field: key });
  return v;
}

export function int(body, key, { required = true, min = -Infinity, max = Infinity } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${key} is required`, { field: key });
    return undefined;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${key} must be an integer between ${min} and ${max}`, { field: key });
  return n;
}

export function num(body, key, { required = true, min = -Infinity, max = Infinity } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${key} is required`, { field: key });
    return undefined;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw badRequest(`${key} must be a number between ${min} and ${max}`, { field: key });
  return n;
}

export function bool(body, key, { required = false } = {}) {
  const v = body[key];
  if (v === undefined) {
    if (required) throw badRequest(`${key} is required`, { field: key });
    return undefined;
  }
  if (typeof v !== 'boolean') throw badRequest(`${key} must be true or false`, { field: key });
  return v;
}

export function oneOf(body, key, values, { required = true } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${key} is required`, { field: key });
    return undefined;
  }
  if (!values.includes(v)) throw badRequest(`${key} must be one of: ${values.join(', ')}`, { field: key });
  return v;
}

export function timestamp(body, key, { required = true } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${key} is required`, { field: key });
    return undefined;
  }
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > Date.UTC(2100, 0, 1)) throw badRequest(`${key} must be a valid date`, { field: key });
  return t;
}

export function page(query) {
  const p = Math.max(1, Math.min(10_000, parseInt(query.page, 10) || 1));
  const size = Math.max(1, Math.min(100, parseInt(query.pageSize, 10) || 25));
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

export const INSTALL_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
