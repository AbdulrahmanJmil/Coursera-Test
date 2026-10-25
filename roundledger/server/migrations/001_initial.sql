-- RoundLedger initial schema. Timestamps are Unix epoch milliseconds.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  status_reason TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  install_id TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  extension_version TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK (revoked_reason IN ('admin', 'self', 'reassigned')),
  UNIQUE (user_id, install_id)
);
CREATE INDEX devices_install ON devices(install_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  client TEXT NOT NULL CHECK (client IN ('web', 'extension')),
  device_id INTEGER REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  device_limit INTEGER NOT NULL CHECK (device_limit > 0),
  features TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_featured INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE activation_codes (
  id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'redeemed', 'revoked')),
  assigned_user_id INTEGER REFERENCES users(id),
  redeemed_by INTEGER REFERENCES users(id),
  redeemed_at INTEGER,
  valid_until INTEGER,
  note TEXT,
  batch_id TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX codes_status ON activation_codes(status);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER REFERENCES plans(id),
  kind TEXT NOT NULL CHECK (kind IN ('trial', 'paid')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  source TEXT NOT NULL CHECK (source IN ('trial', 'code', 'admin')),
  activation_code_id INTEGER REFERENCES activation_codes(id),
  device_limit INTEGER NOT NULL,
  features TEXT NOT NULL DEFAULT '{}',
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_user ON subscriptions(user_id);

-- One trial per account and one per installation, enforced by UNIQUE keys.
CREATE TABLE trial_claims (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  install_id TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  hint TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  provider TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_usage_created ON ai_usage(created_at);
CREATE INDEX ai_usage_user ON ai_usage(user_id, created_at);

CREATE TABLE rounds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,
  round_key TEXT NOT NULL,
  multiplier REAL NOT NULL CHECK (multiplier >= 1),
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (user_id, platform, round_key)
);
CREATE INDEX rounds_user_platform ON rounds(user_id, platform, observed_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER,
  actor_email TEXT,
  subject_user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  outcome TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_created ON audit_log(created_at);
CREATE INDEX audit_action ON audit_log(action);
CREATE INDEX audit_subject ON audit_log(subject_user_id);

CREATE TABLE error_reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  device_id INTEGER REFERENCES devices(id),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX errors_created ON error_reports(created_at);
