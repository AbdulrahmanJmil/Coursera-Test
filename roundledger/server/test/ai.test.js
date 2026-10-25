import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startFakeGemini, seedRounds } from './helpers.js';

const KEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKE1234567wxyz';

describe('AI provider administration (fake Gemini endpoint)', () => {
  let s, g, cookie;
  before(async () => {
    g = await startFakeGemini();
    s = await startServer({ geminiBaseUrl: g.url });
    cookie = await s.setupAdmin();
  });
  after(async () => { await s.close(); await g.close(); });

  test('missing credentials: model listing fails cleanly and provider cannot be enabled', async () => {
    const r = await s.post('/api/admin/ai/gemini/models', {}, { cookie });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'PROVIDER_MISSING_CREDENTIALS');
    const en = await s.put('/api/admin/ai/gemini', { enabled: true, model: 'test-flash-001' }, { cookie });
    assert.equal(en.status, 400);
    assert.equal(g.calls.length, 0, 'no outbound call without a key');
  });

  test('API key is stored encrypted, masked in responses and never returned', async () => {
    const r = await s.put('/api/admin/ai/gemini/credential', { apiKey: KEY }, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.hint, '••••wxyz');
    const desc = await s.get('/api/admin/ai', { cookie });
    assert.ok(!desc.text.includes(KEY));
    assert.equal(desc.body.providers.gemini.credential.configured, true);
    const row = s.db.prepare('SELECT * FROM secrets').get();
    assert.ok(!JSON.stringify(row).includes(KEY), 'ciphertext must not contain the key');
    const pub = await s.get('/api/public/config');
    assert.ok(!pub.text.includes(KEY));
    const settings = await s.get('/api/admin/settings', { cookie });
    assert.ok(!settings.text.includes(KEY));
    const audit = s.db.prepare("SELECT details FROM audit_log WHERE action = 'ai.credential_set'").get();
    assert.ok(!audit.details.includes(KEY));
  });

  test('model listing uses the header, filters to generateContent models', async () => {
    const r = await s.post('/api/admin/ai/gemini/models', {}, { cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.models.map((m) => m.id), ['test-flash-001']);
    const call = g.calls.at(-1);
    assert.equal(call.headers['x-goog-api-key'], KEY);
    assert.ok(!call.url.includes(KEY), 'key must not be in the URL');
  });

  test('generation test requires explicit charge confirmation', async () => {
    const before = g.calls.length;
    const r = await s.post('/api/admin/ai/gemini/test', { mode: 'generate', model: 'test-flash-001' }, { cookie });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(g.calls.length, before);
    const ok = await s.post('/api/admin/ai/gemini/test', { mode: 'generate', model: 'test-flash-001', confirmCharges: true }, { cookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.reply, 'Your rounds look random.', 'thought parts are excluded');
    assert.equal(ok.body.usage.totalTokens, 160);
    const free = await s.post('/api/admin/ai/gemini/test', { mode: 'models' }, { cookie });
    assert.equal(free.body.ok, true);
  });

  test('configuration validation and enabling', async () => {
    assert.equal((await s.put('/api/admin/ai/gemini', { model: '../../etc' }, { cookie })).status, 400);
    assert.equal((await s.put('/api/admin/ai/gemini', { temperature: 5 }, { cookie })).status, 400);
    assert.equal((await s.put('/api/admin/ai/gemini', { timeoutMs: 10 }, { cookie })).status, 400);
    const r = await s.put('/api/admin/ai/gemini', { enabled: true, model: 'test-flash-001', timeoutMs: 2000, makeActive: true }, { cookie });
    assert.equal(r.status, 200);
    assert.equal((await s.get('/api/public/config')).body.ai.available, true);
  });

  test('invalid credentials are reported as such', async () => {
    await s.put('/api/admin/ai/gemini/credential', { apiKey: 'bad-key-0000000000' }, { cookie });
    const r = await s.post('/api/admin/ai/gemini/test', { mode: 'models' }, { cookie });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'PROVIDER_INVALID_CREDENTIALS');
    const desc = await s.get('/api/admin/ai', { cookie });
    assert.equal(desc.body.providers.gemini.recentErrors[0].error_code, 'INVALID_CREDENTIALS');
    await s.put('/api/admin/ai/gemini/credential', { apiKey: KEY }, { cookie });
  });

  test('rate-limit, server error and timeout responses are mapped', async () => {
    g.setBehavior('ratelimit');
    assert.equal((await s.post('/api/admin/ai/gemini/test', { mode: 'models' }, { cookie })).body.error.code, 'PROVIDER_RATE_LIMITED');
    g.setBehavior('server_error');
    assert.equal((await s.post('/api/admin/ai/gemini/test', { mode: 'models' }, { cookie })).body.error.code, 'PROVIDER_PROVIDER_ERROR');
    g.setBehavior('timeout');
    const t0 = Date.now();
    const r = await s.post('/api/admin/ai/gemini/test', { mode: 'generate', confirmCharges: true }, { cookie });
    assert.equal(r.body.error.code, 'PROVIDER_TIMEOUT');
    assert.ok(Date.now() - t0 < 6000);
    g.setBehavior('ok');
  });

  test('usage is tracked', async () => {
    const desc = await s.get('/api/admin/ai', { cookie });
    const u = desc.body.providers.gemini.usage.today;
    assert.ok(u.requests >= 5);
    assert.ok(u.errors >= 3);
    assert.ok(u.totalTokens >= 160);
  });

  test('deleting the key disables the provider', async () => {
    const r = await s.del('/api/admin/ai/gemini/credential', { cookie });
    assert.equal(r.body.removed, true);
    const desc = await s.get('/api/admin/ai', { cookie });
    assert.equal(desc.body.providers.gemini.enabled, false);
    assert.equal((await s.get('/api/public/config')).body.ai.available, false);
  });
});

describe('AI analysis for users', () => {
  let s, g, cookie, plan;
  before(async () => {
    g = await startFakeGemini();
    s = await startServer({ geminiBaseUrl: g.url });
    cookie = await s.setupAdmin();
    plan = await s.createPlan(cookie, { features: { aiAnalysis: true, cloudHistory: true } });
    await s.put('/api/admin/ai/gemini/credential', { apiKey: KEY }, { cookie });
    await s.put('/api/admin/ai/gemini', { enabled: true, model: 'test-flash-001', makeActive: true }, { cookie });
  });
  after(async () => { await s.close(); await g.close(); });

  test('requires the aiAnalysis feature', async () => {
    await s.makeUser('free@example.com');
    const { token } = await s.loginExtension('free@example.com');
    const r = await s.post('/api/ai/analyze', { platform: 'melbet' }, { token });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FEATURE_NOT_INCLUDED');
  });

  test('requires enough synced rounds, then calls the provider with a no-prediction instruction', async () => {
    const uid = await s.makeUser('pro@example.com');
    await s.post(`/api/admin/users/${uid}/subscriptions`, { planId: plan.id }, { cookie });
    const { token } = await s.loginExtension('pro@example.com');
    const few = await s.post('/api/ai/analyze', { platform: 'melbet' }, { token });
    assert.equal(few.status, 409);
    assert.equal(few.body.error.code, 'NOT_ENOUGH_DATA');
    seedRounds(s.db, uid, 'melbet', Array.from({ length: 60 }, (_, i) => 1 + (i % 7) * 0.7));
    const r = await s.post('/api/ai/analyze', { platform: 'melbet' }, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.text, 'Your rounds look random.');
    assert.equal(r.body.basedOnRounds, 60);
    const call = g.calls.at(-1);
    assert.match(call.body.systemInstruction.parts[0].text, /Never predict/);
    assert.ok(!JSON.stringify(r.body).includes(KEY));
  });

  test('per-user daily limit is enforced', async () => {
    const { cookie: c } = { cookie };
    await s.put('/api/admin/settings/usage', { aiRequestsPerUserPerDay: 1, maxRoundsPerUpload: 500, maxStoredRoundsPerPlatform: 20000 }, { cookie: c });
    const { token } = await s.loginExtension('pro@example.com');
    const r = await s.post('/api/ai/analyze', { platform: 'melbet' }, { token });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'AI_DAILY_LIMIT');
  });

  test('provider failures surface as a generic 502 to users', async () => {
    await s.put('/api/admin/settings/usage', { aiRequestsPerUserPerDay: 100, maxRoundsPerUpload: 500, maxStoredRoundsPerPlatform: 20000 }, { cookie });
    g.setBehavior('server_error');
    const { token } = await s.loginExtension('pro@example.com');
    const r = await s.post('/api/ai/analyze', { platform: 'melbet' }, { token });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'AI_PROVIDER_ERROR');
    g.setBehavior('ok');
  });

  test('disabled provider gives an honest unavailable status', async () => {
    await s.put('/api/admin/ai/gemini', { enabled: false }, { cookie });
    const { token } = await s.loginExtension('pro@example.com');
    const r = await s.post('/api/ai/analyze', { platform: 'melbet' }, { token });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'AI_UNAVAILABLE');
  });
});

describe('without APP_ENCRYPTION_KEY', () => {
  test('secrets cannot be stored', async () => {
    const s = await startServer({ encryptionKey: null });
    const cookie = await s.setupAdmin();
    const r = await s.put('/api/admin/ai/gemini/credential', { apiKey: KEY }, { cookie });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'ENCRYPTION_KEY_MISSING');
    await s.close();
  });
});
