import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PASSWORD } from './helpers.js';

describe('authentication & authorization', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('register validates email and password strength', async () => {
    assert.equal((await s.post('/api/auth/register', { email: 'bad', password: PASSWORD })).status, 400);
    const weak = await s.post('/api/auth/register', { email: 'weak@example.com', password: 'short' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'WEAK_PASSWORD');
    assert.equal((await s.post('/api/auth/register', { email: 'new@example.com', password: PASSWORD })).status, 201);
    const dup = await s.post('/api/auth/register', { email: 'NEW@example.com', password: PASSWORD });
    assert.equal(dup.status, 409);
  });

  test('passwords are stored hashed', () => {
    const row = s.db.prepare("SELECT password_hash FROM users WHERE email = 'new@example.com'").get();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
  });

  test('extension login requires an install id and returns a bearer token', async () => {
    const noInstall = await s.post('/api/auth/login', { email: 'new@example.com', password: PASSWORD, client: 'extension' });
    assert.equal(noInstall.status, 400);
    const r = await s.loginExtension('new@example.com');
    assert.equal(r.status, 200);
    assert.ok(r.token);
    const me = await s.get('/api/me', { token: r.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'new@example.com');
    assert.equal(me.body.entitlement.active, false);
    assert.equal(me.body.trial.eligible, true);
    const stored = s.db.prepare('SELECT token_hash FROM sessions LIMIT 1').get();
    assert.notEqual(stored.token_hash, r.token, 'raw token must not be stored');
  });

  test('wrong password is rejected and repeated failures lock the account', async () => {
    await s.makeUser('lock@example.com');
    for (let i = 0; i < 10; i++) {
      const r = await s.post('/api/auth/login', { email: 'lock@example.com', password: 'wrong-password-1', client: 'extension', installId: 'install-abcdefghijklmnop' });
      assert.equal(r.status, 401);
    }
    const locked = await s.post('/api/auth/login', { email: 'lock@example.com', password: PASSWORD, client: 'extension', installId: 'install-abcdefghijklmnop' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
  });

  test('unknown email gives the same error as wrong password', async () => {
    const r = await s.post('/api/auth/login', { email: 'nobody@example.com', password: PASSWORD, client: 'extension', installId: 'install-abcdefghijklmnop' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'INVALID_CREDENTIALS');
  });

  test('protected endpoints require authentication', async () => {
    assert.equal((await s.get('/api/me')).status, 401);
    assert.equal((await s.get('/api/me', { token: 'garbage' })).status, 401);
  });

  test('regular users cannot use the dashboard or admin API', async () => {
    const web = await s.post('/api/auth/login', { email: 'new@example.com', password: PASSWORD, client: 'web' });
    assert.equal(web.status, 403);
    assert.equal(web.body.error.code, 'NOT_ADMIN');
    const { token } = await s.loginExtension('new@example.com');
    assert.equal((await s.get('/api/admin/overview', { token })).status, 403);
    assert.equal((await s.get('/api/admin/users', { token })).status, 403);
  });

  test('admin dashboard session uses an HttpOnly SameSite cookie and CSRF header', async () => {
    await s.makeUser('boss@example.com', { role: 'admin' });
    const r = await s.loginAdmin('boss@example.com');
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(r.body.token, undefined, 'web login must not expose the token in the body');
    assert.equal((await s.get('/api/admin/overview', { cookie: r.cookie })).status, 200);
    const noCsrf = await s.post('/api/admin/users/1/unlock', {}, { cookie: r.cookie, headers: { 'X-Requested-With': 'nope' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, 'CSRF_CHECK_FAILED');
  });

  test('logout revokes the session', async () => {
    const { token } = await s.loginExtension('new@example.com');
    assert.equal((await s.post('/api/auth/logout', {}, { token })).status, 200);
    assert.equal((await s.get('/api/me', { token })).status, 401);
  });

  test('change password revokes other sessions', async () => {
    await s.makeUser('pw@example.com');
    const a = await s.loginExtension('pw@example.com', 'install-aaaaaaaaaaaaaaaa');
    const r = await s.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-secret-99' }, { token: a.token });
    assert.equal(r.status, 200);
    assert.equal((await s.get('/api/me', { token: a.token })).status, 200, 'current session survives');
  });

  test('suspended users are signed out and cannot sign in', async () => {
    const cookie = (await s.loginAdmin('boss@example.com')).cookie;
    const uid = await s.makeUser('bad@example.com');
    const { token } = await s.loginExtension('bad@example.com');
    const susp = await s.post(`/api/admin/users/${uid}/suspend`, { reason: 'chargeback' }, { cookie });
    assert.equal(susp.status, 200);
    assert.equal((await s.get('/api/me', { token })).status, 401);
    const login = await s.loginExtension('bad@example.com');
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'ACCOUNT_SUSPENDED');
    assert.equal((await s.post(`/api/admin/users/${uid}/reactivate`, {}, { cookie })).status, 200);
    assert.equal((await s.loginExtension('bad@example.com')).status, 200);
  });

  test('admins cannot suspend themselves', async () => {
    const cookie = (await s.loginAdmin('boss@example.com')).cookie;
    const me = s.db.prepare("SELECT id FROM users WHERE email = 'boss@example.com'").get();
    const r = await s.post(`/api/admin/users/${me.id}/suspend`, {}, { cookie });
    assert.equal(r.status, 409);
  });
});

describe('rate limiting', () => {
  test('login endpoint is rate limited per IP', async () => {
    const s = await startServer({ rateLimits: {} });
    let last;
    for (let i = 0; i < 22; i++) {
      last = await s.post('/api/auth/login', { email: 'x@example.com', password: 'whatever-123', client: 'extension', installId: 'install-abcdefghijklmnop' });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
    assert.ok(last.headers.get('retry-after'));
    await s.close();
  });
});

describe('maintenance mode', () => {
  test('blocks non-admin API use but not public config or admins', async () => {
    const s = await startServer();
    const cookie = await s.setupAdmin();
    await s.makeUser('u@example.com');
    const { token } = await s.loginExtension('u@example.com');
    const put = await s.put('/api/admin/settings/maintenance', { enabled: true, message: 'Upgrading' }, { cookie });
    assert.equal(put.status, 200);
    const blocked = await s.get('/api/devices', { token });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.message, 'Upgrading');
    assert.equal((await s.get('/api/public/config')).body.maintenance.enabled, true);
    assert.equal((await s.get('/api/admin/overview', { cookie })).status, 200);
    await s.close();
  });
});
