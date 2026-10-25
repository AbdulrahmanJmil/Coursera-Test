import { HttpError, badRequest, reply } from '../http.js';
import { str, int, EMAIL_RE, INSTALL_ID_RE } from '../validate.js';
import { audit } from '../audit.js';
import { checkCredentials, createUser, createSession, revokeSession, revokeUserSessions, changePassword } from '../services/auth.js';
import { computeEntitlement, requireFeature } from '../services/entitlements.js';
import { startTrial, redeemCode } from '../services/licensing.js';
import { registerDevice, listDevices, removeOwnDevice, publicDevice } from '../services/devices.js';
import { describe, normalizeRounds, isValidMultiplier, isValidRoundKey } from '../../../shared/analysis.js';
import { ADAPTERS } from '../../../shared/adapters/index.js';
import { redact } from '../security.js';

const PLATFORM_RE = /^[a-z0-9_-]{1,32}$/;

function trialEligibility(db, settings, userId, installId) {
  const trial = settings.get('trial');
  if (!trial.enabled) return { eligible: false, reason: 'disabled' };
  if (db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND kind = 'paid' LIMIT 1").get(userId)) return { eligible: false, reason: 'has_paid' };
  const claim = db.prepare('SELECT user_id FROM trial_claims WHERE user_id = ? OR install_id = ?').get(userId, installId ?? '');
  if (claim) return { eligible: false, reason: claim.user_id === userId ? 'used_by_account' : 'used_on_device' };
  return { eligible: true, durationDays: trial.durationDays };
}

export default function registerUser(router, ctx) {
  const { db, settings, ai, config, cookieName } = ctx;

  router.add('POST', '/api/auth/register', { auth: 'public', rate: 'register' }, ({ body, ip }) => {
    if (!settings.get('registration').enabled) throw new HttpError(403, 'REGISTRATION_CLOSED', 'New registrations are currently closed.');
    const email = str(body, 'email', { max: 254, pattern: EMAIL_RE }).toLowerCase();
    const id = createUser(db, { email, password: body.password });
    audit(db, { actor: { id, email }, subjectUserId: id, action: 'user.register', resourceType: 'user', resourceId: id, ip });
    return reply(201, { ok: true });
  });

  router.add('POST', '/api/auth/login', { auth: 'public', rate: 'auth', maintenanceExempt: true }, ({ body, ip, res }) => {
    const email = str(body, 'email', { max: 254 }).toLowerCase();
    const password = str(body, 'password', { max: 200, trim: false });
    const client = body.client === 'web' ? 'web' : 'extension';
    let user;
    try {
      user = checkCredentials(db, email, password);
    } catch (err) {
      const target = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
      if (target?.role === 'admin' || client === 'web') {
        audit(db, { actor: { email }, action: 'auth.login', resourceType: 'user', resourceId: target?.id, outcome: 'failure', details: { client, reason: err.code }, ip });
      }
      throw err;
    }
    if (client === 'web') {
      if (user.role !== 'admin') {
        audit(db, { actor: user, action: 'auth.login', resourceType: 'user', resourceId: user.id, outcome: 'failure', details: { client, reason: 'NOT_ADMIN' }, ip });
        throw new HttpError(403, 'NOT_ADMIN', 'The dashboard is for administrators. Use the browser extension to sign in.');
      }
      const s = createSession(db, { userId: user.id, client: 'web' });
      const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${cookieName}=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - Date.now()) / 1000)}${secure}`);
      audit(db, { actor: user, action: 'auth.login', resourceType: 'user', resourceId: user.id, details: { client }, ip });
      return { user: { id: user.id, email: user.email, role: user.role }, expiresAt: s.expiresAt };
    }
    const installId = str(body, 'installId', { pattern: INSTALL_ID_RE });
    const deviceId = registerDevice(db, settings, {
      userId: user.id, installId,
      name: str(body, 'deviceName', { required: false, max: 80 }),
      version: str(body, 'extensionVersion', { required: false, max: 20 }),
      replaceDeviceId: int(body, 'replaceDeviceId', { required: false, min: 1 }),
    });
    const s = createSession(db, { userId: user.id, client: 'extension', deviceId });
    if (user.role === 'admin') audit(db, { actor: user, action: 'auth.login', resourceType: 'user', resourceId: user.id, details: { client }, ip });
    return { token: s.token, expiresAt: s.expiresAt, user: { id: user.id, email: user.email, role: user.role } };
  });

  router.add('POST', '/api/auth/logout', { auth: 'user', maintenanceExempt: true }, ({ auth, res }) => {
    revokeSession(db, auth.sessionId);
    if (auth.client === 'web') res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  router.add('POST', '/api/auth/change-password', { auth: 'user', rate: 'auth' }, ({ auth, body, ip }) => {
    changePassword(db, auth.user.id, String(body.currentPassword ?? ''), body.newPassword);
    revokeUserSessions(db, auth.user.id, { exceptSessionId: auth.sessionId });
    audit(db, { actor: auth.user, action: 'auth.change_password', resourceType: 'user', resourceId: auth.user.id, ip });
    return { ok: true };
  });

  router.add('GET', '/api/me', { auth: 'user', maintenanceExempt: true }, ({ auth }) => {
    const installId = auth.device?.install_id;
    return {
      user: auth.user,
      entitlement: computeEntitlement(db, settings, auth.user.id),
      trial: trialEligibility(db, settings, auth.user.id, installId),
      ai: ai.publicStatus(),
    };
  });

  router.add('POST', '/api/license/trial', { auth: 'user', client: 'extension', rate: 'redeem' }, ({ auth, ip }) => {
    const r = startTrial(db, settings, auth.user.id, auth.device.install_id);
    audit(db, { actor: auth.user, action: 'license.trial_start', resourceType: 'subscription', resourceId: r.subscriptionId, ip });
    return { ...r, entitlement: computeEntitlement(db, settings, auth.user.id) };
  });

  router.add('POST', '/api/license/redeem', { auth: 'user', rate: 'redeem' }, ({ auth, body, ip }) => {
    const code = str(body, 'code', { max: 40 });
    try {
      const r = redeemCode(db, auth.user.id, code);
      audit(db, { actor: auth.user, action: 'license.redeem', resourceType: 'activation_code', resourceId: r.codeId, details: { subscriptionId: r.subscriptionId, plan: r.plan.name }, ip });
      return { ...r, entitlement: computeEntitlement(db, settings, auth.user.id) };
    } catch (err) {
      audit(db, { actor: auth.user, action: 'license.redeem', resourceType: 'activation_code', outcome: 'failure', details: { reason: err.code }, ip });
      throw err;
    }
  });

  router.add('GET', '/api/devices', { auth: 'user' }, ({ auth }) => {
    const lic = settings.get('licensing');
    return {
      devices: listDevices(db, auth.user.id).map((d) => publicDevice(d, auth.device?.install_id)),
      selfRemovalAllowed: lic.allowSelfDeviceRemoval,
      cooldownHours: lic.selfRemovalCooldownHours,
    };
  });

  router.add('DELETE', '/api/devices/:id', { auth: 'user' }, ({ auth, params, ip }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest('Invalid device id');
    removeOwnDevice(db, settings, auth.user.id, id);
    audit(db, { actor: auth.user, action: 'device.self_remove', resourceType: 'device', resourceId: id, ip });
    return { ok: true };
  });

  router.add('POST', '/api/rounds', { auth: 'user', ratePer: 'user' }, ({ auth, body }) => {
    const ent = computeEntitlement(db, settings, auth.user.id);
    if (!requireFeature(ent, 'cloudHistory')) throw new HttpError(403, 'FEATURE_NOT_INCLUDED', 'Cloud history is not included in your current plan.');
    const platform = str(body, 'platform', { pattern: PLATFORM_RE });
    if (!ADAPTERS[platform]) throw badRequest('Unknown platform');
    const usage = settings.get('usage');
    if (!Array.isArray(body.rounds) || body.rounds.length > usage.maxRoundsPerUpload) {
      throw badRequest(`rounds must be a list of at most ${usage.maxRoundsPerUpload} items`);
    }
    const now = Date.now();
    const ins = db.prepare(`INSERT OR IGNORE INTO rounds (user_id, platform, round_key, multiplier, observed_at, source, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of body.rounds) {
        const t = Number(r?.observedAt);
        if (!r || !isValidRoundKey(r.roundKey) || !isValidMultiplier(r.multiplier) || !Number.isFinite(t) || t > now + 5 * 60_000 || t < now - 365 * 86400_000) {
          rejected++;
          continue;
        }
        const source = r.source === 'snapshot' ? 'snapshot' : 'live';
        if (ins.run(auth.user.id, platform, r.roundKey, Math.round(r.multiplier * 100) / 100, t, source, now).changes) accepted++;
        else duplicates++;
      }
      // Enforce the per-platform storage cap by trimming the oldest rounds.
      db.prepare(`DELETE FROM rounds WHERE id IN (SELECT id FROM rounds WHERE user_id = ? AND platform = ?
        ORDER BY observed_at DESC LIMIT -1 OFFSET ?)`).run(auth.user.id, platform, usage.maxStoredRoundsPerPlatform);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { accepted, duplicates, rejected };
  });

  router.add('GET', '/api/rounds', { auth: 'user' }, ({ auth, query }) => {
    const platform = str(query, 'platform', { pattern: PLATFORM_RE });
    const limit = Math.max(1, Math.min(5000, parseInt(query.limit, 10) || 500));
    const rows = db.prepare(`SELECT round_key AS roundKey, multiplier, observed_at AS observedAt, source FROM rounds
      WHERE user_id = ? AND platform = ? ORDER BY observed_at DESC LIMIT ?`).all(auth.user.id, platform, limit);
    return { rounds: normalizeRounds(rows).rounds };
  });

  router.add('GET', '/api/stats', { auth: 'user' }, ({ auth, query }) => {
    const platform = str(query, 'platform', { pattern: PLATFORM_RE });
    const rows = db.prepare(`SELECT round_key AS roundKey, multiplier, observed_at AS observedAt FROM rounds
      WHERE user_id = ? AND platform = ? ORDER BY observed_at DESC LIMIT 20000`).all(auth.user.id, platform);
    const { rounds } = normalizeRounds(rows);
    return { platform, stats: describe(rounds.map((r) => r.multiplier)) };
  });

  router.add('GET', '/api/ai/status', { auth: 'user' }, () => ai.publicStatus());

  router.add('POST', '/api/ai/analyze', { auth: 'user', rate: 'ai', ratePer: 'user' }, async ({ auth, body }) => {
    const platform = str(body, 'platform', { pattern: PLATFORM_RE });
    return ai.analyze(auth.user, platform);
  });

  router.add('POST', '/api/diagnostics/errors', { auth: 'user', rate: 'diagnostics', ratePer: 'user', maintenanceExempt: true }, ({ auth, body }) => {
    const source = str(body, 'source', { max: 40, pattern: /^[\w.-]+$/ });
    const message = redact(str(body, 'message', { max: 1000 }));
    const context = body.context ? redact(JSON.stringify(body.context)).slice(0, 2000) : null;
    db.prepare('INSERT INTO error_reports (user_id, device_id, source, message, context, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(auth.user.id, auth.device?.id ?? null, source, message, context, Date.now());
    return reply(201, { ok: true });
  });
}
