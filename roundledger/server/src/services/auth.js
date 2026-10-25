import { hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256 } from '../security.js';
import { HttpError } from '../http.js';

export const SESSION_TTL = { web: 12 * 3600_000, extension: 30 * 24 * 3600_000 };
const LOCK_THRESHOLD = 10;
const LOCK_MS = 15 * 60_000;
export const PASSWORD_RULES = { min: 10, max: 200 };

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_RULES.min || pw.length > PASSWORD_RULES.max) {
    throw new HttpError(400, 'WEAK_PASSWORD', `Password must be ${PASSWORD_RULES.min}–${PASSWORD_RULES.max} characters.`);
  }
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new HttpError(400, 'WEAK_PASSWORD', 'Password must contain letters and numbers.');
}

export function createUser(db, { email, password, role = 'user' }) {
  validatePassword(password);
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
  const r = db.prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(email.toLowerCase(), hashPassword(password), role, Date.now());
  return Number(r.lastInsertRowid);
}

/** Verifies credentials with per-account lockout. Returns the user row. */
export function checkCredentials(db, email, password, now = Date.now()) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    verifyPassword(password, DUMMY_HASH);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (user.locked_until && user.locked_until > now) {
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { retryAt: user.locked_until });
  }
  if (!verifyPassword(password, user.password_hash)) {
    const failed = user.failed_logins + 1;
    const lock = failed >= LOCK_THRESHOLD ? now + LOCK_MS : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock, user.id);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.', { userId: user.id });
  }
  if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.');
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now, user.id);
  return user;
}

export function createSession(db, { userId, client, deviceId = null, now = Date.now() }) {
  const token = newToken();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, client, device_id, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, client, deviceId, now, now, now + SESSION_TTL[client]);
  return { token, expiresAt: now + SESSION_TTL[client] };
}

/** Resolves a raw token to { session, user, device } or null. Sliding expiry for extension sessions. */
export function resolveSession(db, token, now = Date.now()) {
  if (!token || token.length > 200) return null;
  const row = db.prepare(`SELECT s.id AS sid, s.client, s.device_id, s.expires_at, s.revoked_at, s.last_used_at,
      u.id, u.email, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row || row.revoked_at || row.expires_at <= now) return null;
  let device = null;
  if (row.device_id) {
    device = db.prepare('SELECT id, install_id, status FROM devices WHERE id = ?').get(row.device_id);
  }
  if (now - row.last_used_at > 60_000) {
    const exp = row.client === 'extension' ? now + SESSION_TTL.extension : row.expires_at;
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(now, exp, row.sid);
    if (device) db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
  }
  return {
    sessionId: row.sid,
    client: row.client,
    user: { id: row.id, email: row.email, role: row.role, status: row.status },
    device,
  };
}

export function revokeSession(db, sessionId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), sessionId);
}

export function revokeUserSessions(db, userId, { exceptSessionId } = {}) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?')
    .run(Date.now(), userId, exceptSessionId ?? null);
}

export function changePassword(db, userId, current, next) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !verifyPassword(current, user.password_hash)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
  validatePassword(next);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
}

export function setPassword(db, userId, next) {
  validatePassword(next);
  const r = db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashPassword(next), userId);
  return r.changes === 1;
}
