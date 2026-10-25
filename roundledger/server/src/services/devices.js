import { tx } from '../db.js';
import { HttpError, notFound, conflict } from '../http.js';
import { computeEntitlement } from './entitlements.js';

const listActive = (db, userId) => db.prepare(`SELECT id, name, install_id, extension_version, first_seen_at, last_seen_at
  FROM devices WHERE user_id = ? AND status = 'active' ORDER BY last_seen_at DESC`).all(userId);

export function publicDevice(d, currentInstallId) {
  return {
    id: d.id, name: d.name, installIdSuffix: d.install_id.slice(-6), extensionVersion: d.extension_version,
    firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at, current: d.install_id === currentInstallId,
  };
}

function cooldownCheck(db, settings, userId, now) {
  const lic = settings.get('licensing');
  if (!lic.allowSelfDeviceRemoval) throw new HttpError(403, 'DEVICE_REMOVAL_DISABLED', 'Removing devices yourself is disabled. Contact support.');
  const last = db.prepare("SELECT MAX(revoked_at) AS t FROM devices WHERE user_id = ? AND revoked_reason = 'self'").get(userId).t;
  const wait = last ? last + lic.selfRemovalCooldownHours * 3600_000 - now : 0;
  if (wait > 0) throw new HttpError(429, 'DEVICE_REMOVAL_COOLDOWN', 'You removed a device recently. Try again later.', { retryAt: now + wait });
}

function revokeRow(db, deviceId, reason, now) {
  db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?").run(now, reason, deviceId);
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
}

/**
 * Registers (or refreshes) an installation for a user and enforces the device
 * limit. When the limit is reached the caller may name one of its own devices
 * to replace, subject to the self-removal policy.
 */
export function registerDevice(db, settings, { userId, installId, name, version, replaceDeviceId }, now = Date.now()) {
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM devices WHERE user_id = ? AND install_id = ?').get(userId, installId);
    if (existing?.status === 'active') {
      db.prepare('UPDATE devices SET last_seen_at = ?, extension_version = ?, name = COALESCE(?, name) WHERE id = ?').run(now, version ?? null, name ?? null, existing.id);
      return existing.id;
    }
    if (existing?.revoked_reason === 'admin') throw new HttpError(403, 'DEVICE_REVOKED', 'This installation was deactivated by an administrator. Contact support.');
    const ent = computeEntitlement(db, settings, userId, now);
    const active = listActive(db, userId);
    if (active.length >= ent.deviceLimit) {
      if (!replaceDeviceId) {
        throw conflict('DEVICE_LIMIT_REACHED', `Your plan allows ${ent.deviceLimit} device(s). Remove one to continue.`, {
          deviceLimit: ent.deviceLimit, devices: active.map((d) => publicDevice(d)),
        });
      }
      const target = active.find((d) => d.id === replaceDeviceId);
      if (!target) throw notFound('Device');
      cooldownCheck(db, settings, userId, now);
      revokeRow(db, target.id, 'self', now);
    }
    if (existing) {
      db.prepare(`UPDATE devices SET status = 'active', revoked_at = NULL, revoked_reason = NULL, last_seen_at = ?, extension_version = ?,
        name = COALESCE(?, name) WHERE id = ?`).run(now, version ?? null, name ?? null, existing.id);
      return existing.id;
    }
    const r = db.prepare(`INSERT INTO devices (user_id, install_id, name, extension_version, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(userId, installId, name ?? null, version ?? null, now, now);
    return Number(r.lastInsertRowid);
  });
}

export function listDevices(db, userId) {
  return listActive(db, userId);
}

export function removeOwnDevice(db, settings, userId, deviceId, now = Date.now()) {
  return tx(db, () => {
    const d = db.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ? AND status = 'active'").get(deviceId, userId);
    if (!d) throw notFound('Device');
    cooldownCheck(db, settings, userId, now);
    revokeRow(db, d.id, 'self', now);
  });
}

export function adminRevokeDevice(db, deviceId, now = Date.now()) {
  return tx(db, () => {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!d) throw notFound('Device');
    if (d.status === 'revoked' && d.revoked_reason === 'admin') throw conflict('ALREADY_REVOKED', 'Device is already revoked.');
    revokeRow(db, d.id, 'admin', now);
    return d;
  });
}

/** Clears an admin revocation so the installation may sign in again (subject to limits). */
export function adminRestoreDevice(db, deviceId) {
  const r = db.prepare("UPDATE devices SET revoked_reason = 'self' WHERE id = ? AND status = 'revoked' AND revoked_reason = 'admin'").run(deviceId);
  if (r.changes !== 1) throw conflict('NOT_ADMIN_REVOKED', 'Only administrator-revoked devices can be restored.');
}

/** Moves an installation to another account, enforcing the target's device limit. */
export function adminReassignDevice(db, settings, deviceId, targetUserId, now = Date.now()) {
  return tx(db, () => {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!d) throw notFound('Device');
    if (d.user_id === targetUserId) throw conflict('SAME_USER', 'Device already belongs to that user.');
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!target) throw notFound('Target user');
    const ent = computeEntitlement(db, settings, targetUserId, now);
    if (listActive(db, targetUserId).length >= ent.deviceLimit) throw conflict('DEVICE_LIMIT_REACHED', 'Target account has no free device slot.');
    revokeRow(db, d.id, 'reassigned', now);
    const clash = db.prepare('SELECT id FROM devices WHERE user_id = ? AND install_id = ?').get(targetUserId, d.install_id);
    if (clash) {
      db.prepare("UPDATE devices SET status = 'active', revoked_at = NULL, revoked_reason = NULL, last_seen_at = ? WHERE id = ?").run(now, clash.id);
      return { from: d.user_id, to: targetUserId, deviceId: clash.id };
    }
    const r = db.prepare(`INSERT INTO devices (user_id, install_id, name, extension_version, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(targetUserId, d.install_id, d.name, d.extension_version, now, now);
    return { from: d.user_id, to: targetUserId, deviceId: Number(r.lastInsertRowid) };
  });
}
