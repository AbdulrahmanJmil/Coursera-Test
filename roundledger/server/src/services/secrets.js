import { encryptSecret, decryptSecret, maskSecret } from '../security.js';
import { HttpError } from '../http.js';

/**
 * Encrypted-at-rest secret store. Values are encrypted with APP_ENCRYPTION_KEY
 * (AES-256-GCM) and are never returned by any API; only a masked hint is.
 */
export class SecretStore {
  constructor(db, key) {
    this.db = db;
    this.key = key;
  }

  get available() {
    return !!this.key;
  }

  set(name, value, actorId) {
    if (!this.key) throw new HttpError(503, 'ENCRYPTION_KEY_MISSING', 'APP_ENCRYPTION_KEY is not configured on the server, so secrets cannot be stored.');
    const enc = encryptSecret(this.key, value);
    this.db.prepare(`INSERT INTO secrets (key, ciphertext, iv, tag, hint, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
        hint = excluded.hint, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(name, enc.ciphertext, enc.iv, enc.tag, maskSecret(value), Date.now(), actorId ?? null);
  }

  delete(name) {
    return this.db.prepare('DELETE FROM secrets WHERE key = ?').run(name).changes > 0;
  }

  /** Public description: { configured, hint, updatedAt }. */
  describe(name) {
    const row = this.db.prepare('SELECT hint, updated_at FROM secrets WHERE key = ?').get(name);
    return row ? { configured: true, hint: row.hint, updatedAt: row.updated_at } : { configured: false, hint: '', updatedAt: null };
  }

  /** Server-internal only. Returns null when unset or undecryptable. */
  reveal(name) {
    if (!this.key) return null;
    const row = this.db.prepare('SELECT ciphertext, iv, tag FROM secrets WHERE key = ?').get(name);
    if (!row) return null;
    try {
      return decryptSecret(this.key, row);
    } catch {
      return null;
    }
  }
}
