import { badRequest, notFound, conflict, reply } from '../http.js';
import { str, int, bool, oneOf, timestamp, page, EMAIL_RE } from '../validate.js';
import { audit } from '../audit.js';
import { FEATURE_KEYS } from '../settings.js';
import { revokeUserSessions, createUser, setPassword } from '../services/auth.js';
import { computeEntitlement } from '../services/entitlements.js';
import { generateCodes, grantSubscription, renewSubscription, updateSubscription, revokeCode, assignCode, getSubscription } from '../services/licensing.js';
import { adminRevokeDevice, adminRestoreDevice, adminReassignDevice } from '../services/devices.js';
import { dbFileSize } from './public.js';

const A = { auth: 'admin' };
const CURRENCY_RE = /^[A-Z]{3}$/;
const PLAN_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const idParam = (params, key = 'id') => {
  const n = Number(params[key]);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`Invalid ${key}`);
  return n;
};
const like = (q) => `%${String(q).replace(/[%_\\]/g, (c) => '\\' + c)}%`;

function planOut(p) {
  return {
    id: p.id, code: p.code, name: p.name, description: p.description, priceCents: p.price_cents, currency: p.currency,
    durationDays: p.duration_days, deviceLimit: p.device_limit, features: JSON.parse(p.features), isActive: !!p.is_active,
    isFeatured: !!p.is_featured, displayOrder: p.display_order, createdAt: p.created_at, updatedAt: p.updated_at,
    subscriptionCount: p.subscription_count ?? undefined,
  };
}

function subOut(s) {
  return {
    id: s.id, userId: s.user_id, planId: s.plan_id, planName: s.plan_name ?? null, kind: s.kind, status: s.status, source: s.source,
    activationCodeId: s.activation_code_id, deviceLimit: s.device_limit, features: JSON.parse(s.features || '{}'),
    startsAt: s.starts_at, expiresAt: s.expires_at, note: s.note, createdAt: s.created_at, updatedAt: s.updated_at,
  };
}

function codeOut(c) {
  return {
    id: c.id, hint: c.code_hint, planId: c.plan_id, planName: c.plan_name, durationDays: c.duration_days, status: c.status,
    assignedUserId: c.assigned_user_id, assignedEmail: c.assigned_email ?? null, redeemedBy: c.redeemed_by,
    redeemedEmail: c.redeemed_email ?? null, redeemedAt: c.redeemed_at, validUntil: c.valid_until, note: c.note,
    batchId: c.batch_id, createdAt: c.created_at, revokedAt: c.revoked_at,
  };
}

function parsePlanBody(body, { partial }) {
  const req = !partial;
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  set('code', str(body, 'code', { required: req, pattern: PLAN_CODE_RE, max: 40 }));
  set('name', str(body, 'name', { required: req, min: 1, max: 80 }));
  set('description', str(body, 'description', { required: false, max: 500 }) ?? (req ? '' : undefined));
  set('price_cents', int(body, 'priceCents', { required: req, min: 0, max: 100_000_000 }));
  const currency = str(body, 'currency', { required: req, max: 3 });
  if (currency !== undefined) {
    if (!CURRENCY_RE.test(currency.toUpperCase())) throw badRequest('currency must be a 3-letter ISO code', { field: 'currency' });
    out.currency = currency.toUpperCase();
  }
  set('duration_days', int(body, 'durationDays', { required: req, min: 1, max: 3650 }));
  set('device_limit', int(body, 'deviceLimit', { required: req, min: 1, max: 50 }));
  if (body.features !== undefined) {
    if (!body.features || typeof body.features !== 'object') throw badRequest('features must be an object', { field: 'features' });
    const f = {};
    for (const k of FEATURE_KEYS) {
      const v = body.features[k] ?? false;
      if (typeof v !== 'boolean') throw badRequest(`features.${k} must be true or false`, { field: 'features' });
      f[k] = v;
    }
    out.features = JSON.stringify(f);
  } else if (req) out.features = JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, false])));
  const b = (k, col) => { const v = bool(body, k); if (v !== undefined) out[col] = v ? 1 : 0; };
  b('isActive', 'is_active');
  b('isFeatured', 'is_featured');
  set('display_order', int(body, 'displayOrder', { required: false, min: 0, max: 10000 }));
  return out;
}

export default function registerAdmin(router, ctx) {
  const { db, settings, ai, config, version, startedAt } = ctx;
  const auditA = (auth, ip, e) => audit(db, { actor: auth.user, ip, ...e });

  // ---------------------------------------------------------------- overview
  router.add('GET', '/api/admin/overview', A, () => {
    const now = Date.now();
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const users = one(`SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'suspended') AS suspended,
      SUM(role = 'admin') AS admins FROM users`);
    const subs = one(`SELECT
        SUM(status = 'active' AND starts_at <= ? AND expires_at > ? AND kind = 'paid') AS activePaid,
        SUM(status = 'active' AND starts_at <= ? AND expires_at > ? AND kind = 'trial') AS activeTrials,
        SUM(status = 'active' AND starts_at > ?) AS scheduled,
        SUM(status = 'active' AND expires_at <= ?) AS expired,
        SUM(status = 'suspended') AS suspended, SUM(status = 'revoked') AS revoked FROM subscriptions`, now, now, now, now, now, now);
    const codes = one(`SELECT SUM(status = 'available') AS available, SUM(status = 'redeemed') AS redeemed,
      SUM(status = 'revoked') AS revoked FROM activation_codes`);
    const devices = one(`SELECT SUM(status = 'active') AS active, SUM(status = 'revoked') AS revoked,
      SUM(status = 'active' AND last_seen_at > ?) AS seen7d FROM devices`, now - 7 * 86400_000);
    const errors24h = one('SELECT COUNT(*) AS n FROM error_reports WHERE created_at > ?', now - 86400_000).n;
    const aiInfo = ai.describe();
    return {
      generatedAt: now,
      users, subscriptions: subs, codes, devices,
      ai: {
        activeProvider: aiInfo.activeProvider,
        publicStatus: ai.publicStatus(),
        encryptionAvailable: aiInfo.encryptionAvailable,
        providers: Object.fromEntries(Object.entries(aiInfo.providers).map(([k, p]) => [k, {
          enabled: p.enabled, model: p.model, credentialConfigured: p.credential.configured, usage: p.usage, lastError: p.recentErrors[0] ?? null,
        }])),
      },
      clientErrors24h: errors24h,
      recentActivity: db.prepare('SELECT id, actor_email, action, resource_type, resource_id, outcome, created_at FROM audit_log ORDER BY id DESC LIMIT 12').all(),
      health: {
        version, node: process.version, uptimeSec: Math.round((now - startedAt) / 1000), database: 'ok',
        databaseBytes: dbFileSize(config), encryptionKeyConfigured: !!config.encryptionKey,
        configProblems: config.problems, maintenance: settings.get('maintenance').enabled,
      },
    };
  });

  // ------------------------------------------------------------------- users
  router.add('GET', '/api/admin/users', A, ({ query }) => {
    const pg = page(query);
    const where = [];
    const args = [];
    if (query.q) { where.push("u.email LIKE ? ESCAPE '\\'"); args.push(like(query.q)); }
    if (query.status) { where.push('u.status = ?'); args.push(oneOf(query, 'status', ['active', 'suspended'])); }
    if (query.role) { where.push('u.role = ?'); args.push(oneOf(query, 'role', ['user', 'admin'])); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${w}`).get(...args).n;
    const now = Date.now();
    const items = db.prepare(`SELECT u.id, u.email, u.role, u.status, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.status = 'active') AS active_devices,
        (SELECT MAX(expires_at) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' AND s.starts_at <= ? AND s.expires_at > ?) AS access_until
      FROM users u ${w} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(now, now, ...args, pg.pageSize, pg.offset);
    return { items, total, page: pg.page, pageSize: pg.pageSize };
  });

  router.add('POST', '/api/admin/users', A, ({ auth, body, ip }) => {
    const email = str(body, 'email', { max: 254, pattern: EMAIL_RE }).toLowerCase();
    const id = createUser(db, { email, password: body.password });
    auditA(auth, ip, { subjectUserId: id, action: 'user.create', resourceType: 'user', resourceId: id, details: { email } });
    return reply(201, { id });
  });

  router.add('GET', '/api/admin/users/:id', A, ({ params }) => {
    const id = idParam(params);
    const user = db.prepare('SELECT id, email, role, status, status_reason, created_at, last_login_at, locked_until FROM users WHERE id = ?').get(id);
    if (!user) throw notFound('User');
    return {
      user,
      entitlement: computeEntitlement(db, settings, id),
      subscriptions: db.prepare(`SELECT s.*, p.name AS plan_name FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = ? ORDER BY s.id DESC`).all(id).map(subOut),
      devices: db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC').all(id),
      codes: db.prepare(`SELECT c.*, p.name AS plan_name FROM activation_codes c JOIN plans p ON p.id = c.plan_id
        WHERE c.assigned_user_id = ? OR c.redeemed_by = ? ORDER BY c.id DESC LIMIT 50`).all(id, id).map(codeOut),
      trialClaim: db.prepare('SELECT claimed_at, install_id FROM trial_claims WHERE user_id = ?').get(id) ?? null,
      rounds: db.prepare('SELECT platform, COUNT(*) AS count, MAX(observed_at) AS last FROM rounds WHERE user_id = ? GROUP BY platform').all(id),
      aiUsage: db.prepare(`SELECT COUNT(*) AS requests, SUM(outcome = 'error') AS errors, MAX(created_at) AS last
        FROM ai_usage WHERE user_id = ? AND purpose = 'analysis'`).get(id),
      activity: db.prepare(`SELECT id, actor_email, action, resource_type, resource_id, outcome, details, created_at FROM audit_log
        WHERE actor_user_id = ? OR subject_user_id = ? ORDER BY id DESC LIMIT 50`).all(id, id),
      errors: db.prepare('SELECT id, source, message, created_at FROM error_reports WHERE user_id = ? ORDER BY id DESC LIMIT 25').all(id),
    };
  });

  const setUserStatus = (status) => ({ auth, params, body, ip }) => {
    const id = idParam(params);
    if (id === auth.user.id) throw conflict('SELF_ACTION', 'You cannot change the status of your own account.');
    const user = db.prepare('SELECT id, email, status FROM users WHERE id = ?').get(id);
    if (!user) throw notFound('User');
    if (user.status === status) throw conflict('NO_CHANGE', `User is already ${status}.`);
    const reason = str(body, 'reason', { required: false, max: 300 }) ?? null;
    db.prepare('UPDATE users SET status = ?, status_reason = ? WHERE id = ?').run(status, reason, id);
    if (status === 'suspended') revokeUserSessions(db, id);
    auditA(auth, ip, { subjectUserId: id, action: status === 'suspended' ? 'user.suspend' : 'user.reactivate', resourceType: 'user', resourceId: id, details: { email: user.email, reason } });
    return { ok: true };
  };
  router.add('POST', '/api/admin/users/:id/suspend', A, setUserStatus('suspended'));
  router.add('POST', '/api/admin/users/:id/reactivate', A, setUserStatus('active'));

  router.add('POST', '/api/admin/users/:id/unlock', A, ({ auth, params, ip }) => {
    const id = idParam(params);
    if (db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(id).changes !== 1) throw notFound('User');
    auditA(auth, ip, { subjectUserId: id, action: 'user.unlock', resourceType: 'user', resourceId: id });
    return { ok: true };
  });

  router.add('POST', '/api/admin/users/:id/password', A, ({ auth, params, body, ip }) => {
    const id = idParam(params);
    if (!setPassword(db, id, body.password)) throw notFound('User');
    revokeUserSessions(db, id);
    auditA(auth, ip, { subjectUserId: id, action: 'user.password_reset', resourceType: 'user', resourceId: id });
    return { ok: true };
  });

  router.add('POST', '/api/admin/users/:id/sessions/revoke', A, ({ auth, params, ip }) => {
    const id = idParam(params);
    revokeUserSessions(db, id);
    auditA(auth, ip, { subjectUserId: id, action: 'user.sessions_revoke', resourceType: 'user', resourceId: id });
    return { ok: true };
  });

  router.add('POST', '/api/admin/users/:id/subscriptions', A, ({ auth, params, body, ip }) => {
    const userId = idParam(params);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw notFound('User');
    const r = grantSubscription(db, {
      userId, planId: int(body, 'planId', { min: 1 }),
      durationDays: int(body, 'durationDays', { required: false, min: 1, max: 3650 }),
      note: str(body, 'note', { required: false, max: 300 }),
    });
    auditA(auth, ip, { subjectUserId: userId, action: 'subscription.grant', resourceType: 'subscription', resourceId: r.subscriptionId, details: { userId, ...r } });
    return reply(201, r);
  });

  // ----------------------------------------------------------- subscriptions
  router.add('GET', '/api/admin/subscriptions', A, ({ query }) => {
    const pg = page(query);
    const now = Date.now();
    const where = [];
    const args = [];
    if (query.state === 'current') { where.push("s.status = 'active' AND s.starts_at <= ? AND s.expires_at > ?"); args.push(now, now); }
    else if (query.state === 'expired') { where.push("s.status = 'active' AND s.expires_at <= ?"); args.push(now); }
    else if (query.state === 'suspended' || query.state === 'revoked') { where.push('s.status = ?'); args.push(query.state); }
    if (query.kind) { where.push('s.kind = ?'); args.push(oneOf(query, 'kind', ['trial', 'paid'])); }
    if (query.q) { where.push("u.email LIKE ? ESCAPE '\\'"); args.push(like(query.q)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const base = `FROM subscriptions s JOIN users u ON u.id = s.user_id LEFT JOIN plans p ON p.id = s.plan_id ${w}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args).n;
    const items = db.prepare(`SELECT s.*, p.name AS plan_name, u.email ${base} ORDER BY s.id DESC LIMIT ? OFFSET ?`)
      .all(...args, pg.pageSize, pg.offset).map((s) => ({ ...subOut(s), email: s.email }));
    return { items, total, page: pg.page, pageSize: pg.pageSize };
  });

  router.add('PATCH', '/api/admin/subscriptions/:id', A, ({ auth, params, body, ip }) => {
    const id = idParam(params);
    const change = {
      status: oneOf(body, 'status', ['active', 'suspended', 'revoked'], { required: false }),
      expiresAt: timestamp(body, 'expiresAt', { required: false }),
    };
    if (change.status === undefined && change.expiresAt === undefined) throw badRequest('Nothing to change');
    const r = updateSubscription(db, id, change);
    const action = change.status === 'revoked' ? 'subscription.revoke' : change.status === 'suspended' ? 'subscription.suspend'
      : change.status === 'active' && r.before.status !== 'active' ? 'subscription.reactivate' : 'subscription.update';
    auditA(auth, ip, { subjectUserId: getSubscription(db, id).user_id, action, resourceType: 'subscription', resourceId: id, details: r });
    return r;
  });

  router.add('POST', '/api/admin/subscriptions/:id/renew', A, ({ auth, params, body, ip }) => {
    const id = idParam(params);
    const days = int(body, 'days', { min: 1, max: 3650 });
    const r = renewSubscription(db, id, days);
    auditA(auth, ip, { subjectUserId: getSubscription(db, id).user_id, action: 'subscription.renew', resourceType: 'subscription', resourceId: id, details: { days, ...r } });
    return r;
  });

  // ------------------------------------------------------------------- plans
  router.add('GET', '/api/admin/plans', A, () => ({
    items: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) AS subscription_count
      FROM plans p ORDER BY p.display_order, p.id`).all().map(planOut),
    featureKeys: FEATURE_KEYS,
  }));

  router.add('POST', '/api/admin/plans', A, ({ auth, body, ip }) => {
    const p = parsePlanBody(body, { partial: false });
    if (db.prepare('SELECT 1 FROM plans WHERE code = ?').get(p.code)) throw conflict('PLAN_CODE_TAKEN', 'A plan with this code already exists.');
    const now = Date.now();
    const cols = { is_active: 1, is_featured: 0, display_order: 0, ...p, created_at: now, updated_at: now };
    const keys = Object.keys(cols);
    const r = db.prepare(`INSERT INTO plans (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(cols));
    const id = Number(r.lastInsertRowid);
    auditA(auth, ip, { action: 'plan.create', resourceType: 'plan', resourceId: id, details: { name: p.name, price: p.price_cents, currency: p.currency } });
    return reply(201, planOut(db.prepare('SELECT * FROM plans WHERE id = ?').get(id)));
  });

  router.add('PATCH', '/api/admin/plans/:id', A, ({ auth, params, body, ip }) => {
    const id = idParam(params);
    const before = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    if (!before) throw notFound('Plan');
    const p = parsePlanBody(body, { partial: true });
    if (p.code && p.code !== before.code) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ?').get(id).n;
      if (used) throw conflict('PLAN_IN_USE', 'The code of a plan with subscriptions cannot change.');
      if (db.prepare('SELECT 1 FROM plans WHERE code = ? AND id != ?').get(p.code, id)) throw conflict('PLAN_CODE_TAKEN', 'A plan with this code already exists.');
    }
    if (!Object.keys(p).length) throw badRequest('Nothing to change');
    p.updated_at = Date.now();
    db.prepare(`UPDATE plans SET ${Object.keys(p).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(p), id);
    const after = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    auditA(auth, ip, { action: 'plan.update', resourceType: 'plan', resourceId: id, details: { before: planOut(before), after: planOut(after) } });
    // Existing subscriptions keep the device limit and features they were sold with.
    return planOut(after);
  });

  // ------------------------------------------------------------------- codes
  router.add('GET', '/api/admin/codes', A, ({ query }) => {
    const pg = page(query);
    const where = [];
    const args = [];
    if (query.status) { where.push('c.status = ?'); args.push(oneOf(query, 'status', ['available', 'redeemed', 'revoked'])); }
    if (query.planId) { where.push('c.plan_id = ?'); args.push(Number(query.planId)); }
    if (query.batchId) { where.push('c.batch_id = ?'); args.push(String(query.batchId)); }
    if (query.q) { where.push("(ua.email LIKE ? ESCAPE '\\' OR ur.email LIKE ? ESCAPE '\\' OR c.code_hint LIKE ? ESCAPE '\\' OR c.note LIKE ? ESCAPE '\\')"); args.push(like(query.q), like(query.q), like(query.q), like(query.q)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const base = `FROM activation_codes c JOIN plans p ON p.id = c.plan_id LEFT JOIN users ua ON ua.id = c.assigned_user_id
      LEFT JOIN users ur ON ur.id = c.redeemed_by ${w}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args).n;
    const items = db.prepare(`SELECT c.*, p.name AS plan_name, ua.email AS assigned_email, ur.email AS redeemed_email ${base}
      ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...args, pg.pageSize, pg.offset).map(codeOut);
    return { items, total, page: pg.page, pageSize: pg.pageSize };
  });

  const userIdByEmail = (email) => {
    if (!email) return null;
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (!u) throw badRequest('No user with that email', { field: 'assignedEmail' });
    return u.id;
  };

  router.add('POST', '/api/admin/codes', A, ({ auth, body, ip }) => {
    const r = generateCodes(db, {
      planId: int(body, 'planId', { min: 1 }),
      count: int(body, 'count', { min: 1, max: 500 }),
      durationDays: int(body, 'durationDays', { required: false, min: 1, max: 3650 }),
      assignedUserId: userIdByEmail(str(body, 'assignedEmail', { required: false, max: 254 })),
      validUntil: timestamp(body, 'validUntil', { required: false }),
      note: str(body, 'note', { required: false, max: 300 }),
      actorId: auth.user.id,
    });
    auditA(auth, ip, { action: 'code.generate', resourceType: 'activation_code_batch', resourceId: r.batchId, details: { count: r.codes.length, plan: r.plan.name } });
    // Plain codes are returned exactly once; only hashes are stored.
    return reply(201, r);
  });

  router.add('POST', '/api/admin/codes/:id/revoke', A, ({ auth, params, ip }) => {
    const id = idParam(params);
    revokeCode(db, id);
    auditA(auth, ip, { action: 'code.revoke', resourceType: 'activation_code', resourceId: id });
    return { ok: true };
  });

  router.add('POST', '/api/admin/codes/:id/assign', A, ({ auth, params, body, ip }) => {
    const id = idParam(params);
    const userId = userIdByEmail(str(body, 'email', { required: false, max: 254 }));
    assignCode(db, id, userId);
    auditA(auth, ip, { subjectUserId: userId, action: 'code.assign', resourceType: 'activation_code', resourceId: id });
    return { ok: true };
  });

  // ----------------------------------------------------------------- devices
  router.add('GET', '/api/admin/devices', A, ({ query }) => {
    const pg = page(query);
    const where = [];
    const args = [];
    if (query.userId) { where.push('d.user_id = ?'); args.push(Number(query.userId)); }
    if (query.status) { where.push('d.status = ?'); args.push(oneOf(query, 'status', ['active', 'revoked'])); }
    if (query.q) { where.push("(u.email LIKE ? ESCAPE '\\' OR d.install_id LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\')"); args.push(like(query.q), like(query.q), like(query.q)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const base = `FROM devices d JOIN users u ON u.id = d.user_id ${w}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args).n;
    const items = db.prepare(`SELECT d.*, u.email ${base} ORDER BY d.last_seen_at DESC LIMIT ? OFFSET ?`).all(...args, pg.pageSize, pg.offset);
    return { items, total, page: pg.page, pageSize: pg.pageSize };
  });

  router.add('POST', '/api/admin/devices/:id/revoke', A, ({ auth, params, ip }) => {
    const id = idParam(params);
    const d = adminRevokeDevice(db, id);
    auditA(auth, ip, { subjectUserId: d.user_id, action: 'device.revoke', resourceType: 'device', resourceId: id });
    return { ok: true };
  });

  router.add('POST', '/api/admin/devices/:id/restore', A, ({ auth, params, ip }) => {
    const id = idParam(params);
    adminRestoreDevice(db, id);
    auditA(auth, ip, { action: 'device.restore', resourceType: 'device', resourceId: id });
    return { ok: true };
  });

  router.add('POST', '/api/admin/devices/:id/reassign', A, ({ auth, params, body, ip }) => {
    const id = idParam(params);
    const r = adminReassignDevice(db, settings, id, userIdByEmail(str(body, 'email', { max: 254 })));
    auditA(auth, ip, { subjectUserId: r.from, action: 'device.reassign', resourceType: 'device', resourceId: id, details: r });
    auditA(auth, ip, { subjectUserId: r.to, action: 'device.reassign', resourceType: 'device', resourceId: r.deviceId, details: r });
    return r;
  });

  // ---------------------------------------------------------------- settings
  router.add('GET', '/api/admin/settings', A, () => {
    const all = settings.all();
    delete all.ai; // managed through the AI provider endpoints
    return all;
  });

  router.add('PUT', '/api/admin/settings/:key', A, ({ auth, params, body, ip }) => {
    const key = params.key;
    if (key === 'ai') throw badRequest('Use the AI provider endpoints for AI settings.');
    const value = key === 'platforms' ? body.platforms : body;
    const r = settings.set(key, value, auth.user.id);
    auditA(auth, ip, { action: 'settings.update', resourceType: 'setting', resourceId: key, details: { before: r.before, after: r.after } });
    return r.after;
  });

  // ------------------------------------------------------------ AI providers
  router.add('GET', '/api/admin/ai', A, () => ai.describe());

  router.add('PUT', '/api/admin/ai/:provider', A, ({ auth, params, body, ip }) => {
    const r = ai.updateProviderConfig(params.provider, body, auth.user.id);
    auditA(auth, ip, { action: 'ai.config_update', resourceType: 'ai_provider', resourceId: params.provider, details: r });
    return r.after;
  });

  router.add('PUT', '/api/admin/ai/:provider/credential', A, ({ auth, params, body, ip }) => {
    const d = ai.setApiKey(params.provider, body.apiKey, auth.user.id);
    auditA(auth, ip, { action: 'ai.credential_set', resourceType: 'ai_provider', resourceId: params.provider, details: { hint: d.hint } });
    return d;
  });

  router.add('DELETE', '/api/admin/ai/:provider/credential', A, ({ auth, params, ip }) => {
    const removed = ai.deleteApiKey(params.provider, auth.user.id);
    auditA(auth, ip, { action: 'ai.credential_delete', resourceType: 'ai_provider', resourceId: params.provider, details: { removed } });
    return { ok: true, removed };
  });

  router.add('POST', '/api/admin/ai/:provider/models', A, async ({ auth, params, ip }) => {
    try {
      const models = await ai.listModels(params.provider, auth.user.id);
      return { models, fetchedAt: Date.now() };
    } catch (err) {
      auditA(auth, ip, { action: 'ai.list_models', resourceType: 'ai_provider', resourceId: params.provider, outcome: 'failure', details: { errorCode: err.code } });
      throw err;
    }
  });

  router.add('POST', '/api/admin/ai/:provider/test', A, async ({ auth, params, body, ip }) => {
    const mode = oneOf(body, 'mode', ['models', 'generate']);
    try {
      const r = await ai.testConnection(params.provider, { mode, confirmCharges: body.confirmCharges, model: str(body, 'model', { required: false, max: 80 }) }, auth.user.id);
      auditA(auth, ip, { action: 'ai.test', resourceType: 'ai_provider', resourceId: params.provider, details: { mode, model: r.model ?? null } });
      return r;
    } catch (err) {
      if (err.code !== 'CONFIRMATION_REQUIRED') {
        auditA(auth, ip, { action: 'ai.test', resourceType: 'ai_provider', resourceId: params.provider, outcome: 'failure', details: { mode, errorCode: err.code } });
      }
      throw err;
    }
  });

  // ------------------------------------------------------- audit & errors
  router.add('GET', '/api/admin/audit', A, ({ query }) => {
    const pg = page(query);
    const where = [];
    const args = [];
    if (query.action) { where.push("action LIKE ? ESCAPE '\\'"); args.push(like(query.action)); }
    if (query.actor) { where.push("actor_email LIKE ? ESCAPE '\\'"); args.push(like(query.actor)); }
    if (query.outcome) { where.push('outcome = ?'); args.push(oneOf(query, 'outcome', ['success', 'failure'])); }
    if (query.resourceType) { where.push('resource_type = ?'); args.push(String(query.resourceType)); }
    if (query.resourceId) { where.push('resource_id = ?'); args.push(String(query.resourceId)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).get(...args).n;
    const items = db.prepare(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, pg.pageSize, pg.offset);
    return { items, total, page: pg.page, pageSize: pg.pageSize };
  });

  router.add('GET', '/api/admin/errors', A, ({ query }) => {
    const pg = page(query);
    const total = db.prepare('SELECT COUNT(*) AS n FROM error_reports').get().n;
    const items = db.prepare(`SELECT e.*, u.email FROM error_reports e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(pg.pageSize, pg.offset);
    return { items, total, page: pg.page, pageSize: pg.pageSize };
  });
}
