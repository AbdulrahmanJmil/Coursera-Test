import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

describe('admin dashboard API', () => {
  let s, cookie, plan, uid, token;
  before(async () => {
    s = await startServer();
    cookie = await s.setupAdmin();
    plan = await s.createPlan(cookie, { features: { aiAnalysis: false, cloudHistory: true } });
    uid = await s.makeUser('alice@example.com');
    await s.makeUser('bob@example.com');
    token = (await s.loginExtension('alice@example.com')).token;
  });
  after(() => s.close());

  test('overview reports counts from real records', async () => {
    const r = await s.get('/api/admin/overview', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.users.total, 3);
    assert.equal(r.body.users.admins, 1);
    assert.equal(r.body.devices.active, 1);
    assert.equal(r.body.subscriptions.activePaid, null, 'no subscriptions yet → SUM over zero rows');
    assert.equal(r.body.ai.publicStatus.available, false);
    assert.ok(r.body.health.uptimeSec >= 0);
  });

  test('user search, filter and pagination', async () => {
    const all = await s.get('/api/admin/users?pageSize=2', { cookie });
    assert.equal(all.body.total, 3);
    assert.equal(all.body.items.length, 2);
    const p2 = await s.get('/api/admin/users?pageSize=2&page=2', { cookie });
    assert.equal(p2.body.items.length, 1);
    const q = await s.get('/api/admin/users?q=ali', { cookie });
    assert.deepEqual(q.body.items.map((u) => u.email), ['alice@example.com']);
    const pct = await s.get('/api/admin/users?q=%25', { cookie });
    assert.equal(pct.body.total, 0, 'LIKE wildcards are escaped');
    assert.equal((await s.get('/api/admin/users?status=bogus', { cookie })).status, 400);
  });

  test('user detail includes devices, subscriptions and activity', async () => {
    await s.post(`/api/admin/users/${uid}/subscriptions`, { planId: plan.id }, { cookie });
    const r = await s.get(`/api/admin/users/${uid}`, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.devices.length, 1);
    assert.equal(r.body.subscriptions.length, 1);
    assert.equal(r.body.entitlement.active, true);
    assert.ok(r.body.activity.length >= 1);
    assert.equal((await s.get('/api/admin/users/99999', { cookie })).status, 404);
  });

  test('platform configuration is validated', async () => {
    const cur = (await s.get('/api/admin/settings', { cookie })).body.platforms;
    assert.equal(cur.length, 2);
    const bad = structuredClone(cur);
    bad[0].pageUrlPatterns = ['javascript:alert(1)'];
    assert.equal((await s.put('/api/admin/settings/platforms', { platforms: bad }, { cookie })).status, 400);
    const bad2 = structuredClone(cur);
    bad2[1].id = 'unknown';
    assert.equal((await s.put('/api/admin/settings/platforms', { platforms: bad2 }, { cookie })).status, 400);
    const good = structuredClone(cur);
    good[0].pageUrlPatterns.push('https://*.example-mirror.com/games-frame/games/371*');
    const r = await s.put('/api/admin/settings/platforms', { platforms: good }, { cookie });
    assert.equal(r.status, 200);
    assert.equal((await s.get('/api/public/config')).body.platforms[0].pageUrlPatterns.length, 2);
  });

  test('AI settings cannot be changed through the generic settings endpoint', async () => {
    assert.equal((await s.put('/api/admin/settings/ai', { activeProvider: 'x' }, { cookie })).status, 400);
    assert.equal((await s.get('/api/admin/settings', { cookie })).body.ai, undefined);
  });

  test('audit log records actor, action, resource and outcome', async () => {
    const r = await s.get('/api/admin/audit?action=settings', { cookie });
    assert.ok(r.body.total >= 1);
    const e = r.body.items[0];
    assert.equal(e.actor_email, 'admin@example.com');
    assert.equal(e.resource_type, 'setting');
    assert.equal(e.outcome, 'success');
    assert.ok(e.created_at > 0);
    const logins = await s.get('/api/admin/audit?action=auth.login', { cookie });
    assert.ok(logins.body.total >= 1, 'admin logins are audited');
  });

  test('client error reports are stored redacted and listed', async () => {
    const r = await s.post('/api/diagnostics/errors', { source: 'panel', message: 'boom Bearer abc.def key=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXX', context: { v: 1 } }, { token });
    assert.equal(r.status, 201);
    const list = await s.get('/api/admin/errors', { cookie });
    assert.equal(list.body.total, 1);
    assert.ok(!list.body.items[0].message.includes('abc.def'));
    assert.ok(!list.body.items[0].message.includes('AIzaSy'));
  });

  test('admin can reset a password; old sessions end', async () => {
    const r1 = await s.post(`/api/admin/users/${uid}/password`, { password: 'short' }, { cookie });
    assert.equal(r1.status, 400);
    const r = await s.post(`/api/admin/users/${uid}/password`, { password: 'brand-new-pass-7' }, { cookie });
    assert.equal(r.status, 200);
    assert.equal((await s.get('/api/me', { token })).status, 401);
    const login = await s.post('/api/auth/login', { email: 'alice@example.com', password: 'brand-new-pass-7', client: 'extension', installId: 'install-' + 'a'.repeat(20) });
    assert.notEqual(login.status, 401);
    token = (await s.post('/api/auth/login', { email: 'alice@example.com', password: 'brand-new-pass-7', client: 'extension', installId: s.db.prepare('SELECT install_id FROM devices WHERE user_id = ? AND status = ?').get(uid, 'active').install_id })).body.token;
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.password_reset'").get());
  });

  test('admin can create users', async () => {
    const r = await s.post('/api/admin/users', { email: 'carol@example.com', password: 'carol-password-1' }, { cookie });
    assert.equal(r.status, 201);
  });

  test('unknown routes and wrong methods', async () => {
    assert.equal((await s.get('/api/nope')).status, 404);
    assert.equal((await s.request('PATCH', '/api/health')).status, 405);
    assert.equal((await s.request('POST', '/api/auth/login', { body: undefined, headers: { 'Content-Type': 'text/plain' } })).status, 400);
  });

  test('dashboard static files are served with a strict CSP', async () => {
    const r = await s.get('/admin/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const traversal = await s.get('/admin/../../package.json');
    assert.ok(!traversal.text.includes('"engines"'));
  });
});

describe('round history sync', () => {
  let s, cookie, plan, uid, token;
  before(async () => {
    s = await startServer();
    cookie = await s.setupAdmin();
    plan = await s.createPlan(cookie, { features: { aiAnalysis: false, cloudHistory: true } });
    uid = await s.makeUser('r@example.com');
    token = (await s.loginExtension('r@example.com')).token;
  });
  after(() => s.close());

  const now = Date.now();
  const rounds = [
    { roundKey: '101', multiplier: 1.5, observedAt: now - 3000 },
    { roundKey: '102', multiplier: 2.31, observedAt: now - 2000 },
    { roundKey: '103', multiplier: 12, observedAt: now - 1000 },
  ];

  test('requires the cloudHistory entitlement', async () => {
    const r = await s.post('/api/rounds', { platform: 'melbet', rounds }, { token });
    assert.equal(r.status, 403);
  });

  test('accepts valid rounds, ignores duplicates and rejects malformed ones', async () => {
    await s.post(`/api/admin/users/${uid}/subscriptions`, { planId: plan.id }, { cookie });
    const r = await s.post('/api/rounds', { platform: 'melbet', rounds: [...rounds, { roundKey: '101', multiplier: 9, observedAt: now }, { roundKey: 'x y', multiplier: 2, observedAt: now }, { roundKey: '104', multiplier: 0.5, observedAt: now }] }, { token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { accepted: 3, duplicates: 1, rejected: 2 });
    const again = await s.post('/api/rounds', { platform: 'melbet', rounds }, { token });
    assert.deepEqual(again.body, { accepted: 0, duplicates: 3, rejected: 0 });
    const stored = s.db.prepare("SELECT multiplier FROM rounds WHERE round_key = '101'").get();
    assert.equal(stored.multiplier, 1.5, 'first observation wins');
  });

  test('rejects unknown platforms and oversized uploads', async () => {
    assert.equal((await s.post('/api/rounds', { platform: 'casino-x', rounds }, { token })).status, 400);
    const big = Array.from({ length: 501 }, (_, i) => ({ roundKey: String(i), multiplier: 2, observedAt: now }));
    assert.equal((await s.post('/api/rounds', { platform: 'melbet', rounds: big }, { token })).status, 400);
  });

  test('stats and history come back from stored data', async () => {
    const st = await s.get('/api/stats?platform=melbet', { token });
    assert.equal(st.body.stats.n, 3);
    assert.equal(st.body.stats.median, 2.31);
    const h = await s.get('/api/rounds?platform=melbet', { token });
    assert.deepEqual(h.body.rounds.map((r) => r.roundKey), ['101', '102', '103']);
  });

  test('users only see their own rounds', async () => {
    await s.makeUser('eve@example.com');
    const { token: t2 } = await s.loginExtension('eve@example.com');
    const st = await s.get('/api/stats?platform=melbet', { token: t2 });
    assert.equal(st.body.stats.n, 0);
  });
});
