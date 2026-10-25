import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { normalizeActivationCode, redact, maskSecret, encryptSecret, decryptSecret } from '../src/security.js';
import crypto from 'node:crypto';

test('production config requires encryption key, https URL and extension origin', () => {
  const c = loadConfig({ NODE_ENV: 'production' });
  assert.equal(c.problems.length, 3);
  const ok = loadConfig({ NODE_ENV: 'production', APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), PUBLIC_BASE_URL: 'https://api.example.com', EXTENSION_ORIGINS: 'chrome-extension://abc' });
  assert.deepEqual(ok.problems, []);
  assert.equal(loadConfig({ APP_ENCRYPTION_KEY: 'short' }).problems.length, 1);
});

test('activation code normalization tolerates spacing, case and look-alike letters', () => {
  assert.equal(normalizeActivationCode('rl-abcd-efgh-jkmn-pqrs'), 'RL-ABCD-EFGH-JKMN-PQRS');
  assert.equal(normalizeActivationCode('ABCD EFGH JKMN PQRO'), 'RL-ABCD-EFGH-JKMN-PQR0');
  assert.equal(normalizeActivationCode('RL-ABCD'), null);
});

test('secrets: AES-GCM round trip, tamper detection, masking and redaction', () => {
  const key = crypto.randomBytes(32);
  const e = encryptSecret(key, 'AIzaSECRET123456789012345');
  assert.equal(decryptSecret(key, e), 'AIzaSECRET123456789012345');
  assert.throws(() => decryptSecret(key, { ...e, tag: Buffer.alloc(16).toString('base64') }));
  assert.equal(maskSecret('abcdefgh1234'), '••••1234');
  assert.ok(!redact('key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWX&x=1').includes('AIzaSy'));
});
