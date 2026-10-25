import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { computeEntitlement } from '../src/services/entitlements.js';

const DAY = 86400_000;

describe('trials', () => {
  let s, cookie;
  before(async () => { s = await startServer(); cookie = await s.setupAdmin(); });
  after(() => s.close());

  test('a trial can be started once per account', async () => {
    await s.makeUser('t1@example.com');
    const { token } = await s.loginExtension('t1@example.com', 'install-trial-device-0001');
    const r = await s.post('/api/license/trial', {}, { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.entitlement.state, 'trial');
    assert.equal(r.body.entitlement.daysLeft, 3);
    const again = await s.post('/api/license/trial', {}, { token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'TRIAL_ALREADY_USED');
  });

  test('a new account on the same installation cannot start another trial', async () => {
    await s.makeUser('t2@example.com');
    const { token } = await s.loginExtension('t2@example.com', 'install-trial-device-0001');
    const r = await s.post('/api/license/trial', {}, { token });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /installation/);
    const me = await s.get('/api/me', { token });
    assert.equal(me.body.trial.eligible, false);
  });

  test('trial duration comes from admin settings and expires server-side', async () => {
    const put = await s.put('/api/admin/settings/trial', { enabled: true, durationDays: 7, deviceLimit: 1, features: { aiAnalysis: false, cloudHistory: true } }, { cookie });
    assert.equal(put.status, 200);
    const uid = await s.makeUser('t3@example.com');
    const { token } = await s.loginExtension('t3@example.com', 'install-trial-device-0003');
    const r = await s.post('/api/license/trial', {}, { token });
    assert.equal(r.body.entitlement.daysLeft, 7);
    const later = computeEntitlement(s.db, s.ctx.settings, uid, Date.now() + 8 * DAY);
    assert.equal(later.active, false);
    assert.equal(later.state, 'trial_expired');
  });

  test('trials can be disabled', async () => {
    await s.put('/api/admin/settings/trial', { enabled: false, durationDays: 7, deviceLimit: 1, features: {} }, { cookie });
    await s.makeUser('t4@example.com');
    const { token } = await s.loginExtension('t4@example.com', 'install-trial-device-0004');
    const r = await s.post('/api/license/trial', {}, { token });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'TRIAL_DISABLED');
  });

  test('invalid trial settings are rejected', async () => {
    const r = await s.put('/api/admin/settings/trial', { enabled: true, durationDays: 0, deviceLimit: 1, features: {} }, { cookie });
    assert.equal(r.status, 400);
  });
});

describe('activation codes', () => {
  let s, cookie, plan;
  before(async () => {
    s = await startServer();
    cookie = await s.setupAdmin();
    plan = await s.createPlan(cookie, { deviceLimit: 2, durationDays: 30 });
  });
  after(() => s.close());

  const gen = async (body = {}) => (await s.post('/api/admin/codes', { planId: plan.id, count: 1, ...body }, { cookie })).body.codes;

  test('codes are returned once and stored only as hashes', async () => {
    const r = await s.post('/api/admin/codes', { planId: plan.id, count: 3, note: 'batch A' }, { cookie });
    assert.equal(r.status, 201);
    assert.equal(r.body.codes.length, 3);
    for (const c of r.body.codes) assert.match(c.code, /^RL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const rows = s.db.prepare('SELECT * FROM activation_codes').all();
    for (const row of rows) for (const c of r.body.codes) assert.ok(!JSON.stringify(row).includes(c.code));
    const list = await s.get('/api/admin/codes?status=available', { cookie });
    assert.equal(list.body.total, 3);
    assert.ok(!JSON.stringify(list.body).includes(r.body.codes[0].code));
  });

  test('redeeming activates a paid subscription with the plan device limit', async () => {
    const [c] = await gen();
    await s.makeUser('buyer@example.com');
    const { token } = await s.loginExtension('buyer@example.com');
    const r = await s.post('/api/license/redeem', { code: c.code.toLowerCase().replace(/-/g, ' ') }, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entitlement.state, 'active');
    assert.equal(r.body.entitlement.deviceLimit, 2);
    assert.equal(r.body.entitlement.features.aiAnalysis, true);
    const dup = await s.post('/api/license/redeem', { code: c.code }, { token });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'CODE_ALREADY_USED');
  });

  test('concurrent redemptions of one code: exactly one succeeds', async () => {
    const [c] = await gen();
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      await s.makeUser(`race${i}@example.com`);
      tokens.push((await s.loginExtension(`race${i}@example.com`)).token);
    }
    const results = await Promise.all(tokens.map((token) => s.post('/api/license/redeem', { code: c.code }, { token })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 4);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE activation_code_id = ?').get(c.id).n, 1);
  });

  test('a second code extends coverage instead of overlapping', async () => {
    const [c] = await gen();
    const { token } = await s.loginExtension('buyer@example.com');
    const before = (await s.get('/api/me', { token })).body.entitlement;
    const r = await s.post('/api/license/redeem', { code: c.code }, { token });
    assert.equal(r.status, 200);
    assert.ok(Math.abs(r.body.startsAt - before.expiresAt) < 1000);
    assert.ok(r.body.entitlement.coveredUntil > before.expiresAt + 29 * DAY);
  });

  test('invalid, revoked, expired and assigned-elsewhere codes are rejected', async () => {
    await s.makeUser('other@example.com');
    const { token } = await s.loginExtension('other@example.com');
    assert.equal((await s.post('/api/license/redeem', { code: 'RL-0000-0000-0000-0000' }, { token })).body.error.code, 'INVALID_CODE');
    assert.equal((await s.post('/api/license/redeem', { code: 'nonsense' }, { token })).body.error.code, 'INVALID_CODE');

    const [rev] = await gen();
    assert.equal((await s.post(`/api/admin/codes/${rev.id}/revoke`, {}, { cookie })).status, 200);
    assert.equal((await s.post('/api/license/redeem', { code: rev.code }, { token })).body.error.code, 'CODE_REVOKED');

    const [exp] = await gen();
    s.db.prepare('UPDATE activation_codes SET valid_until = ? WHERE id = ?').run(Date.now() - 1000, exp.id);
    assert.equal((await s.post('/api/license/redeem', { code: exp.code }, { token })).body.error.code, 'CODE_EXPIRED');

    const [assigned] = await gen({ assignedEmail: 'buyer@example.com' });
    const wrongUser = await s.post('/api/license/redeem', { code: assigned.code }, { token });
    assert.equal(wrongUser.status, 403);
    assert.equal(wrongUser.body.error.code, 'CODE_ASSIGNED_ELSEWHERE');
  });

  test('used codes cannot be revoked; their subscription can', async () => {
    const used = s.db.prepare("SELECT id FROM activation_codes WHERE status = 'redeemed' LIMIT 1").get();
    const r = await s.post(`/api/admin/codes/${used.id}/revoke`, {}, { cookie });
    assert.equal(r.status, 409);
  });

  test('codes cannot be generated for inactive plans', async () => {
    const off = await s.createPlan(cookie, { isActive: false });
    const r = await s.post('/api/admin/codes', { planId: off.id, count: 1 }, { cookie });
    assert.equal(r.status, 409);
  });

  test('redemption attempts are audited without the code', async () => {
    const rows = s.db.prepare("SELECT * FROM audit_log WHERE action = 'license.redeem'").all();
    assert.ok(rows.some((r) => r.outcome === 'success'));
    assert.ok(rows.some((r) => r.outcome === 'failure'));
    assert.ok(!rows.some((r) => /RL-[0-9A-Z]{4}-/.test(r.details || '')));
  });
});

describe('subscriptions (admin)', () => {
  let s, cookie, plan, uid, token;
  before(async () => {
    s = await startServer();
    cookie = await s.setupAdmin();
    plan = await s.createPlan(cookie, { durationDays: 30, deviceLimit: 1, features: { aiAnalysis: false, cloudHistory: true } });
    uid = await s.makeUser('sub@example.com');
    token = (await s.loginExtension('sub@example.com')).token;
  });
  after(() => s.close());

  test('grant, renew, change expiry, suspend, reactivate, revoke', async () => {
    const g = await s.post(`/api/admin/users/${uid}/subscriptions`, { planId: plan.id, durationDays: 10, note: 'support goodwill' }, { cookie });
    assert.equal(g.status, 201);
    const sid = g.body.subscriptionId;
    assert.equal((await s.get('/api/me', { token })).body.entitlement.daysLeft, 10);

    const ren = await s.post(`/api/admin/subscriptions/${sid}/renew`, { days: 5 }, { cookie });
    assert.equal(ren.status, 200);
    assert.equal((await s.get('/api/me', { token })).body.entitlement.daysLeft, 15);

    const newExp = Date.now() + 2 * DAY;
    assert.equal((await s.patch(`/api/admin/subscriptions/${sid}`, { expiresAt: new Date(newExp).toISOString() }, { cookie })).status, 200);
    assert.equal((await s.get('/api/me', { token })).body.entitlement.daysLeft, 2);

    assert.equal((await s.patch(`/api/admin/subscriptions/${sid}`, { status: 'suspended' }, { cookie })).status, 200);
    assert.equal((await s.get('/api/me', { token })).body.entitlement.state, 'suspended');
    assert.equal((await s.patch(`/api/admin/subscriptions/${sid}`, { status: 'active' }, { cookie })).status, 200);
    assert.equal((await s.get('/api/me', { token })).body.entitlement.active, true);

    assert.equal((await s.patch(`/api/admin/subscriptions/${sid}`, { status: 'revoked' }, { cookie })).status, 200);
    const me = (await s.get('/api/me', { token })).body.entitlement;
    assert.equal(me.active, false);
    assert.equal(me.state, 'revoked');
    assert.equal((await s.patch(`/api/admin/subscriptions/${sid}`, { status: 'active' }, { cookie })).status, 409, 'revocation is final');
    assert.equal((await s.post(`/api/admin/subscriptions/${sid}/renew`, { days: 5 }, { cookie })).status, 409);

    const actions = s.db.prepare("SELECT action FROM audit_log WHERE resource_type = 'subscription'").all().map((r) => r.action);
    for (const a of ['subscription.grant', 'subscription.renew', 'subscription.update', 'subscription.suspend', 'subscription.reactivate', 'subscription.revoke']) {
      assert.ok(actions.includes(a), `missing audit ${a}`);
    }
  });

  test('subscription expiry ends access', async () => {
    const g = await s.post(`/api/admin/users/${uid}/subscriptions`, { planId: plan.id, durationDays: 1 }, { cookie });
    const sub = s.db.prepare('SELECT expires_at FROM subscriptions WHERE id = ?').get(g.body.subscriptionId);
    const ent = computeEntitlement(s.db, s.ctx.settings, uid, sub.expires_at + 1);
    assert.equal(ent.active, false);
    assert.equal(ent.state, 'expired');
  });

  test('editing a plan does not change existing subscriptions', async () => {
    const before = (await s.get('/api/me', { token })).body.entitlement;
    const r = await s.patch(`/api/admin/plans/${plan.id}`, { deviceLimit: 5, features: { aiAnalysis: true, cloudHistory: true }, priceCents: 2999 }, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.deviceLimit, 5);
    const after = (await s.get('/api/me', { token })).body.entitlement;
    assert.equal(after.deviceLimit, before.deviceLimit);
    assert.equal(after.features.aiAnalysis, false);
  });

  test('plan validation', async () => {
    assert.equal((await s.post('/api/admin/plans', { code: 'x', name: 'X', priceCents: 1, currency: 'USD', durationDays: 30, deviceLimit: 1 }, { cookie })).status, 400);
    assert.equal((await s.post('/api/admin/plans', { code: 'neg', name: 'X', priceCents: -1, currency: 'USD', durationDays: 30, deviceLimit: 1 }, { cookie })).status, 400);
    assert.equal((await s.post('/api/admin/plans', { code: 'cur', name: 'X', priceCents: 1, currency: 'DOLLARS', durationDays: 30, deviceLimit: 1 }, { cookie })).status, 400);
    const dup = await s.post('/api/admin/plans', { code: plan.code, name: 'X', priceCents: 1, currency: 'USD', durationDays: 30, deviceLimit: 1 }, { cookie });
    assert.equal(dup.status, 409);
    const rename = await s.patch(`/api/admin/plans/${plan.id}`, { code: 'renamed' }, { cookie });
    assert.equal(rename.status, 409, 'plan code locked once used');
  });

  test('inactive plans are hidden from the public plan list', async () => {
    await s.patch(`/api/admin/plans/${plan.id}`, { isActive: false }, { cookie });
    const pub = await s.get('/api/public/config');
    assert.ok(!pub.body.plans.some((p) => p.id === plan.id));
  });
});

describe('devices', () => {
  let s, cookie, uid;
  before(async () => {
    s = await startServer();
    cookie = await s.setupAdmin();
    uid = await s.makeUser('dev@example.com');
  });
  after(() => s.close());

  test('device limit is enforced at sign-in', async () => {
    const a = await s.loginExtension('dev@example.com', 'install-device-aaaaaaaaaa');
    assert.equal(a.status, 200);
    const again = await s.loginExtension('dev@example.com', 'install-device-aaaaaaaaaa');
    assert.equal(again.status, 200, 'same install re-signs in');
    const b = await s.loginExtension('dev@example.com', 'install-device-bbbbbbbbbb');
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'DEVICE_LIMIT_REACHED');
    assert.equal(b.body.error.details.devices.length, 1);
  });

  test('a device can be replaced, then a cooldown applies', async () => {
    const existing = s.db.prepare('SELECT id FROM devices WHERE user_id = ?').get(uid);
    const b = await s.loginExtension('dev@example.com', 'install-device-bbbbbbbbbb', { replaceDeviceId: existing.id });
    assert.equal(b.status, 200);
    const old = s.db.prepare('SELECT status, revoked_reason FROM devices WHERE id = ?').get(existing.id);
    assert.deepEqual({ ...old }, { status: 'revoked', revoked_reason: 'self' });
    const bDev = s.db.prepare("SELECT id FROM devices WHERE install_id = 'install-device-bbbbbbbbbb'").get();
    const c = await s.loginExtension('dev@example.com', 'install-device-cccccccccc', { replaceDeviceId: bDev.id });
    assert.equal(c.status, 429);
    assert.equal(c.body.error.code, 'DEVICE_REMOVAL_COOLDOWN');
  });

  test('a replaced device is signed out', async () => {
    const r = await s.loginExtension('dev@example.com', 'install-device-bbbbbbbbbb');
    assert.equal((await s.get('/api/me', { token: r.token })).status, 200);
    const dev = s.db.prepare("SELECT id FROM devices WHERE install_id = 'install-device-bbbbbbbbbb'").get();
    assert.equal((await s.post(`/api/admin/devices/${dev.id}/revoke`, {}, { cookie })).status, 200);
    const after = await s.get('/api/me', { token: r.token });
    assert.equal(after.status, 401);
    const relog = await s.loginExtension('dev@example.com', 'install-device-bbbbbbbbbb');
    assert.equal(relog.status, 403);
    assert.equal(relog.body.error.code, 'DEVICE_REVOKED');
    assert.equal((await s.post(`/api/admin/devices/${dev.id}/restore`, {}, { cookie })).status, 200);
    assert.equal((await s.loginExtension('dev@example.com', 'install-device-bbbbbbbbbb')).status, 200);
  });

  test('admin can reassign an installation to another account within its limit', async () => {
    const other = await s.makeUser('other@example.com');
    const dev = s.db.prepare("SELECT id FROM devices WHERE install_id = 'install-device-bbbbbbbbbb' AND status = 'active'").get();
    const r = await s.post(`/api/admin/devices/${dev.id}/reassign`, { email: 'other@example.com' }, { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.to, other);
    const moved = s.db.prepare("SELECT user_id FROM devices WHERE install_id = 'install-device-bbbbbbbbbb' AND status = 'active'").get();
    assert.equal(moved.user_id, other);
  });

  test('self-removal can be disabled by policy', async () => {
    await s.put('/api/admin/settings/licensing', { defaultDeviceLimit: 1, allowSelfDeviceRemoval: false, selfRemovalCooldownHours: 0 }, { cookie });
    await s.makeUser('policy@example.com');
    const a = await s.loginExtension('policy@example.com', 'install-policy-aaaaaaaaaa');
    const devs = await s.get('/api/devices', { token: a.token });
    assert.equal(devs.body.selfRemovalAllowed, false);
    const del = await s.del(`/api/devices/${devs.body.devices[0].id}`, { token: a.token });
    assert.equal(del.status, 403);
  });
});
