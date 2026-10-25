import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

function parseKey(raw) {
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

/** Reads configuration from environment variables (see .env.example). */
export function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const cfg = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8787),
    databasePath: env.DATABASE_PATH || path.join(SERVER_ROOT, 'data', 'roundledger.db'),
    encryptionKey: parseKey(env.APP_ENCRYPTION_KEY),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    extensionOrigins: (env.EXTENSION_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    geminiBaseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    adminStaticDir: path.join(PROJECT_ROOT, 'admin'),
    logRequests: env.LOG_REQUESTS !== '0',
    ...overrides,
  };
  const problems = [];
  if (env.APP_ENCRYPTION_KEY && !cfg.encryptionKey) problems.push('APP_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).');
  if (cfg.isProduction) {
    if (!cfg.encryptionKey) problems.push('APP_ENCRYPTION_KEY is required in production.');
    if (!cfg.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL must be an https:// URL in production.');
    if (!cfg.extensionOrigins.length) problems.push('EXTENSION_ORIGINS must list the chrome-extension:// origin in production.');
  }
  cfg.problems = problems;
  return cfg;
}
