import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/auth.js';

export const PASSWORD = 'correct-horse-42';

/** Starts the app on an ephemeral port with an in-memory database. */
const RELAXED = Object.fromEntries(['auth', 'register', 'redeem', 'api', 'admin', 'ai', 'diagnostics'].map((k) => [k, { limit: 10_000 }]));

export async function startServer(overrides = {}) {
  const config = loadConfig({}, {
    databasePath: ':memory:', logRequests: false, encryptionKey: crypto.randomBytes(32), rateLimits: RELAXED, ...overrides,
  });
  const { server, db, ctx } = createApp(config, { log: { info() {}, error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, token, cookie, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    if (cookie) { h.Cookie = cookie; h['X-Requested-With'] ??= 'RoundLedger'; }
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers, text };
  }

  const api = {
    base, db, ctx, request,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o = {}) => request('POST', p, { ...o, body }),
    put: (p, body, o = {}) => request('PUT', p, { ...o, body }),
    patch: (p, body, o = {}) => request('PATCH', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };

  api.makeUser = async (email, { role = 'user' } = {}) => {
    const id = createUser(db, { email, password: PASSWORD, role });
    return id;
  };
  api.loginExtension = async (email, installId = 'install-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 24), extra = {}) => {
    const r = await api.post('/api/auth/login', { email, password: PASSWORD, client: 'extension', installId, ...extra });
    return { ...r, token: r.body?.token, installId };
  };
  api.loginAdmin = async (email) => {
    const r = await api.post('/api/auth/login', { email, password: PASSWORD, client: 'web' });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return { ...r, cookie };
  };
  api.setupAdmin = async (email = 'admin@example.com') => {
    await api.makeUser(email, { role: 'admin' });
    return (await api.loginAdmin(email)).cookie;
  };
  api.createPlan = async (cookie, overrides = {}) => {
    const r = await api.post('/api/admin/plans', {
      code: 'monthly-' + crypto.randomBytes(3).toString('hex'), name: 'Monthly', priceCents: 1999, currency: 'usd',
      durationDays: 30, deviceLimit: 2, features: { aiAnalysis: true, cloudHistory: true }, isActive: true, ...overrides,
    }, { cookie });
    if (r.status !== 201) throw new Error('plan create failed ' + JSON.stringify(r.body));
    return r.body;
  };
  return api;
}

/** Fake Gemini endpoint. `behavior` decides each response. */
export async function startFakeGemini() {
  const calls = [];
  let behavior = 'ok';
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (behavior === 'timeout') return; // never respond
    if (req.headers['x-goog-api-key'] === 'bad-key-0000000000') {
      return send(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    }
    if (behavior === 'ratelimit') return send(429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });
    if (behavior === 'server_error') return send(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } });
    if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
      return send(200, { models: [
        { name: 'models/test-flash-001', displayName: 'Test Flash', supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1000, outputTokenLimit: 500 },
        { name: 'models/embed-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      ] });
    }
    if (req.method === 'POST' && /:generateContent$/.test(req.url)) {
      return send(200, {
        candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text: 'Your rounds look random.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 160 },
        modelVersion: 'test-flash-001',
      });
    }
    send(404, { error: { code: 404, message: 'not found' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    setBehavior: (b) => { behavior = b; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

export function seedRounds(db, userId, platform, multipliers, start = Date.now() - multipliers.length * 10_000) {
  const ins = db.prepare('INSERT INTO rounds (user_id, platform, round_key, multiplier, observed_at, source, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  multipliers.forEach((m, i) => ins.run(userId, platform, String(1000 + i), m, start + i * 10_000, 'live', Date.now()));
}
