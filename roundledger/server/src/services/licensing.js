import { tx } from '../db.js';
import { HttpError, notFound, conflict } from '../http.js';
import { newActivationCode, normalizeActivationCode, sha256 } from '../security.js';
import crypto from 'node:crypto';

const DAY = 86400_000;

export function getPlan(db, planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw notFound('Plan');
  return plan;
}

function insertSubscription(db, s, now) {
  const r = db.prepare(`INSERT INTO subscriptions (user_id, plan_id, kind, status, source, activation_code_id, device_limit, features,
      starts_at, expires_at, note, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.userId, s.planId ?? null, s.kind, s.source, s.codeId ?? null, s.deviceLimit, JSON.stringify(s.features),
      s.startsAt, s.expiresAt, s.note ?? null, now, now);
  return Number(r.lastInsertRowid);
}

/** When the user's paid coverage currently ends (or now if none). New paid time stacks after it. */
function paidCoverageEnd(db, userId, now) {
  const row = db.prepare(`SELECT MAX(expires_at) AS end FROM subscriptions
    WHERE user_id = ? AND kind = 'paid' AND status = 'active' AND expires_at > ?`).get(userId, now);
  return Math.max(now, row?.end ?? 0);
}

export function startTrial(db, settings, userId, installId, now = Date.now()) {
  const trial = settings.get('trial');
  if (!trial.enabled) throw new HttpError(403, 'TRIAL_DISABLED', 'Free trials are not currently offered.');
  return tx(db, () => {
    const claimed = db.prepare('SELECT user_id, install_id FROM trial_claims WHERE user_id = ? OR install_id = ?').get(userId, installId);
    if (claimed) {
      throw conflict('TRIAL_ALREADY_USED', claimed.user_id === userId
        ? 'This account has already used its free trial.'
        : 'A free trial has already been used on this installation.');
    }
    const paid = db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND kind = 'paid' LIMIT 1").get(userId);
    if (paid) throw conflict('TRIAL_NOT_ELIGIBLE', 'Trials are only available before a first paid subscription.');
    db.prepare('INSERT INTO trial_claims (user_id, install_id, claimed_at) VALUES (?, ?, ?)').run(userId, installId, now);
    const id = insertSubscription(db, {
      userId, kind: 'trial', source: 'trial', deviceLimit: trial.deviceLimit, features: trial.features,
      startsAt: now, expiresAt: now + trial.durationDays * DAY,
    }, now);
    return { subscriptionId: id, expiresAt: now + trial.durationDays * DAY };
  });
}

export function generateCodes(db, { planId, count, durationDays, assignedUserId, validUntil, note, actorId }, now = Date.now()) {
  const plan = getPlan(db, planId);
  if (!plan.is_active) throw conflict('PLAN_INACTIVE', 'Codes cannot be generated for an inactive plan.');
  const batchId = crypto.randomUUID();
  return tx(db, () => {
    const ins = db.prepare(`INSERT INTO activation_codes (code_hash, code_hint, plan_id, duration_days, assigned_user_id, valid_until,
      note, batch_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const codes = [];
    for (let k = 0; k < count; k++) {
      const code = newActivationCode();
      const r = ins.run(sha256(code), code.slice(0, 3) + '…' + code.slice(-4), plan.id, durationDays ?? plan.duration_days,
        assignedUserId ?? null, validUntil ?? null, note ?? null, batchId, actorId ?? null, now);
      codes.push({ id: Number(r.lastInsertRowid), code });
    }
    return { batchId, plan: { id: plan.id, name: plan.name }, codes };
  });
}

/**
 * Redeems an activation code for a user. The status flip is a compare-and-set
 * inside an IMMEDIATE transaction, so two simultaneous redemptions of the same
 * code cannot both succeed.
 */
export function redeemCode(db, userId, rawCode, now = Date.now()) {
  const code = normalizeActivationCode(rawCode);
  if (!code) throw new HttpError(400, 'INVALID_CODE', 'That activation code is not valid.');
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM activation_codes WHERE code_hash = ?').get(sha256(code));
    if (!row) throw new HttpError(400, 'INVALID_CODE', 'That activation code is not valid.');
    if (row.status === 'redeemed') throw conflict('CODE_ALREADY_USED', 'This activation code has already been used.');
    if (row.status === 'revoked') throw conflict('CODE_REVOKED', 'This activation code has been revoked.');
    if (row.valid_until && row.valid_until <= now) throw conflict('CODE_EXPIRED', 'This activation code has expired.');
    if (row.assigned_user_id && row.assigned_user_id !== userId) throw new HttpError(403, 'CODE_ASSIGNED_ELSEWHERE', 'This activation code is assigned to a different account.');
    const plan = getPlan(db, row.plan_id);
    const flipped = db.prepare(`UPDATE activation_codes SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?
      WHERE id = ? AND status = 'available'`).run(userId, now, row.id);
    if (flipped.changes !== 1) throw conflict('CODE_ALREADY_USED', 'This activation code has already been used.');
    const startsAt = paidCoverageEnd(db, userId, now);
    const expiresAt = startsAt + row.duration_days * DAY;
    const subscriptionId = insertSubscription(db, {
      userId, planId: plan.id, kind: 'paid', source: 'code', codeId: row.id, deviceLimit: plan.device_limit,
      features: JSON.parse(plan.features), startsAt, expiresAt,
    }, now);
    return { codeId: row.id, subscriptionId, plan: { id: plan.id, name: plan.name }, startsAt, expiresAt };
  });
}

export function grantSubscription(db, { userId, planId, durationDays, note }, now = Date.now()) {
  const plan = getPlan(db, planId);
  return tx(db, () => {
    const startsAt = paidCoverageEnd(db, userId, now);
    const expiresAt = startsAt + (durationDays ?? plan.duration_days) * DAY;
    const id = insertSubscription(db, {
      userId, planId: plan.id, kind: 'paid', source: 'admin', deviceLimit: plan.device_limit,
      features: JSON.parse(plan.features), startsAt, expiresAt, note,
    }, now);
    return { subscriptionId: id, startsAt, expiresAt };
  });
}

export function getSubscription(db, id) {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!s) throw notFound('Subscription');
  return s;
}

export function renewSubscription(db, id, days, now = Date.now()) {
  return tx(db, () => {
    const s = getSubscription(db, id);
    if (s.status === 'revoked') throw conflict('SUBSCRIPTION_REVOKED', 'A revoked subscription cannot be renewed.');
    const expiresAt = Math.max(s.expires_at, now) + days * DAY;
    db.prepare('UPDATE subscriptions SET expires_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, now, id);
    return { before: { expiresAt: s.expires_at }, after: { expiresAt } };
  });
}

export function updateSubscription(db, id, { status, expiresAt }, now = Date.now()) {
  return tx(db, () => {
    const s = getSubscription(db, id);
    if (s.status === 'revoked' && status && status !== 'revoked') throw conflict('SUBSCRIPTION_REVOKED', 'Revocation is final; grant a new subscription instead.');
    if (expiresAt !== undefined && expiresAt <= s.starts_at) throw new HttpError(400, 'VALIDATION_ERROR', 'Expiry must be after the start date.');
    const next = { status: status ?? s.status, expiresAt: expiresAt ?? s.expires_at };
    db.prepare('UPDATE subscriptions SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(next.status, next.expiresAt, now, id);
    return { before: { status: s.status, expiresAt: s.expires_at }, after: next };
  });
}

export function revokeCode(db, id, now = Date.now()) {
  const r = db.prepare("UPDATE activation_codes SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'available'").run(now, id);
  if (r.changes !== 1) {
    if (!db.prepare('SELECT 1 FROM activation_codes WHERE id = ?').get(id)) throw notFound('Activation code');
    throw conflict('CODE_NOT_AVAILABLE', 'Only unused codes can be revoked. Revoke the resulting subscription instead.');
  }
}

export function assignCode(db, id, userId) {
  const r = db.prepare("UPDATE activation_codes SET assigned_user_id = ? WHERE id = ? AND status = 'available'").run(userId, id);
  if (r.changes !== 1) {
    if (!db.prepare('SELECT 1 FROM activation_codes WHERE id = ?').get(id)) throw notFound('Activation code');
    throw conflict('CODE_NOT_AVAILABLE', 'Only unused codes can be reassigned.');
  }
}
