import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, migrate } from './db.js';
import { Router, HttpError, readJsonBody, sendJson, parseCookies, setSecurityHeaders, serveStatic } from './http.js';
import { RateLimiter, RATE_LIMITS } from './ratelimit.js';
import { Settings } from './settings.js';
import { SecretStore } from './services/secrets.js';
import { AiService } from './services/ai.js';
import { resolveSession } from './services/auth.js';
import { ProviderError } from './providers/errors.js';
import { PROJECT_ROOT } from './config.js';
import registerPublic from './routes/public.js';
import registerUser from './routes/user.js';
import registerAdmin from './routes/admin.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
export const SESSION_COOKIE = 'rl_session';
const CSRF_HEADER = 'x-requested-with';

export function createApp(config, { db: existingDb, log = console } = {}) {
  const db = existingDb || openDatabase(config.databasePath);
  migrate(db);
  const settings = new Settings(db);
  const secrets = new SecretStore(db, config.encryptionKey);
  const ai = new AiService({ db, settings, secrets, config });
  const limiter = new RateLimiter();
  const router = new Router();
  const startedAt = Date.now();
  const ctx = { db, settings, secrets, ai, config, limiter, version: VERSION, startedAt, cookieName: SESSION_COOKIE };

  registerPublic(router, ctx);
  registerUser(router, ctx);
  registerAdmin(router, ctx);

  const clientIp = (req) => {
    if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  };

  const allowedOrigin = (origin) => {
    if (!origin) return null;
    if (config.extensionOrigins.includes(origin)) return origin;
    if (!config.isProduction && origin.startsWith('chrome-extension://')) return origin;
    return null;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    setSecurityHeaders(res, { https: config.publicBaseUrl.startsWith('https://') });
    const origin = allowedOrigin(req.headers.origin);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (origin) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      res.writeHead(origin ? 204 : 403);
      return res.end();
    }

    if (url.pathname === '/' ) {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      if (url.pathname === '/admin') {
        res.writeHead(302, { Location: '/admin/' });
        return res.end();
      }
      if (serveStatic(res, config.adminStaticDir, url.pathname.slice('/admin/'.length) || 'index.html')) return;
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }

    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'No such endpoint');
    if (m.methodNotAllowed) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    const { route, params } = m;
    const opts = route.options;

    // Authentication: Bearer tokens (extension) or the HttpOnly session cookie (dashboard).
    let auth = null;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (bearer) auth = resolveSession(db, bearer);
    else {
      const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (cookie) {
        auth = resolveSession(db, cookie);
        if (auth && auth.client !== 'web') auth = null;
        // Cookie-authenticated writes must carry a header a cross-site form cannot set.
        if (auth && req.method !== 'GET' && req.headers[CSRF_HEADER] !== 'RoundLedger') {
          throw new HttpError(403, 'CSRF_CHECK_FAILED', 'Missing request header');
        }
      }
    }
    if (auth?.client === 'extension' && auth.device && auth.device.status !== 'active') {
      throw new HttpError(401, 'DEVICE_REVOKED', 'This installation has been signed out. Sign in again.');
    }
    if (opts.auth !== 'public') {
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
      if (auth.user.status !== 'active') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      if (opts.auth === 'admin' && auth.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Administrator access required');
      if (opts.client && auth.client !== opts.client) throw new HttpError(403, 'WRONG_CLIENT', `This endpoint is for the ${opts.client} client`);
    }

    const maintenance = settings.get('maintenance');
    if (maintenance.enabled && !opts.maintenanceExempt && auth?.user.role !== 'admin') {
      throw new HttpError(503, 'MAINTENANCE', maintenance.message || 'Service is under maintenance. Please try again later.');
    }

    const rateName = opts.rate || (opts.auth === 'admin' ? 'admin' : 'api');
    const rl = { ...RATE_LIMITS[rateName], ...(config.rateLimits?.[rateName] || {}) };
    const rateKey = opts.ratePer === 'user' && auth ? `${rateName}:u${auth.user.id}` : `${rateName}:${ip}`;
    const hit = limiter.hit(rateKey, rl.limit, rl.windowMs);
    if (!hit.ok) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Slow down.', { retryAfterSec: hit.retryAfterSec });

    const body = await readJsonBody(req);
    const query = Object.fromEntries(url.searchParams);
    const out = await route.handler({ req, res, params, query, body, auth, ip, ctx });
    if (res.writableEnded) return;
    if (out?.__reply) return sendJson(res, out.status, out.body, out.headers);
    return sendJson(res, 200, out ?? { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      await handle(req, res);
    } catch (err) {
      let status = 500;
      let payload = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } };
      if (err instanceof HttpError) {
        status = err.status;
        const details = err.details && { ...err.details };
        if (details) delete details.userId;
        payload = { error: { code: err.code, message: err.message, ...(details ? { details } : {}) } };
        if (err.code === 'RATE_LIMITED') res.setHeader('Retry-After', String(err.details?.retryAfterSec ?? 60));
      } else if (err instanceof ProviderError) {
        status = 502;
        payload = { error: { code: 'PROVIDER_' + err.code, message: err.message } };
      } else {
        log.error?.(`[error] ${req.method} ${req.url?.split('?')[0]}: ${err.stack || err}`);
      }
      if (!res.headersSent) sendJson(res, status, payload);
      else res.end();
    } finally {
      if (config.logRequests) log.info?.(`${new Date().toISOString()} ${req.method} ${req.url?.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });

  server.on('close', () => limiter.close());
  return { server, db, ctx };
}
