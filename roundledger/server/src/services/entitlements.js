import { FEATURE_KEYS } from '../settings.js';

const DAY = 86400_000;

/**
 * Computes what a user is entitled to right now, entirely server-side.
 * Paid subscriptions take precedence over trials; among equals the one that
 * runs longest wins. Device limit falls back to the licensing default.
 */
export function computeEntitlement(db, settings, userId, now = Date.now()) {
  const user = db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
  const subs = db.prepare(`SELECT s.*, p.name AS plan_name, p.code AS plan_code FROM subscriptions s
    LEFT JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY s.expires_at DESC`).all(userId);
  const current = subs
    .filter((s) => s.status === 'active' && s.starts_at <= now && s.expires_at > now)
    .sort((a, b) => (a.kind === b.kind ? b.expires_at - a.expires_at : a.kind === 'paid' ? -1 : 1))[0];
  const queued = subs.filter((s) => s.status === 'active' && s.starts_at > now).sort((a, b) => a.starts_at - b.starts_at)[0];
  // The most recent thing that happened: an active sub's end date, or the time
  // a sub was suspended/revoked.
  const effectiveEnd = (s) => (s.status === 'active' ? s.expires_at : s.updated_at);
  const latest = subs.filter((s) => s.starts_at <= now).sort((a, b) => effectiveEnd(b) - effectiveEnd(a))[0];
  const licensing = settings.get('licensing');
  const devicesUsed = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND status = 'active'").get(userId).n;
  const noFeatures = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false]));

  if (!user || user.status !== 'active') {
    return { active: false, state: 'account_suspended', features: noFeatures, deviceLimit: licensing.defaultDeviceLimit, devicesUsed };
  }
  if (!current) {
    let state = 'none';
    if (latest?.status === 'revoked') state = 'revoked';
    else if (latest?.status === 'suspended') state = 'suspended';
    else if (latest && latest.expires_at <= now) state = latest.kind === 'trial' ? 'trial_expired' : 'expired';
    return {
      active: false, state, features: noFeatures, deviceLimit: licensing.defaultDeviceLimit, devicesUsed,
      lastExpiredAt: latest?.expires_at ?? null, queuedStartsAt: queued?.starts_at ?? null,
    };
  }
  const features = { ...noFeatures, ...JSON.parse(current.features || '{}') };
  // Continuous coverage: include back-to-back queued subscriptions in the end date.
  let coveredUntil = current.expires_at;
  for (const s of subs.filter((x) => x.status === 'active' && x.starts_at > now).sort((a, b) => a.starts_at - b.starts_at)) {
    if (s.starts_at <= coveredUntil) coveredUntil = Math.max(coveredUntil, s.expires_at);
  }
  return {
    active: true,
    state: current.kind === 'trial' ? 'trial' : 'active',
    subscriptionId: current.id,
    kind: current.kind,
    plan: current.plan_id ? { id: current.plan_id, code: current.plan_code, name: current.plan_name } : null,
    startsAt: current.starts_at,
    expiresAt: current.expires_at,
    coveredUntil,
    daysLeft: Math.max(0, Math.ceil((current.expires_at - now) / DAY)),
    features,
    deviceLimit: current.device_limit,
    devicesUsed,
  };
}

export function requireFeature(ent, feature) {
  return ent.active && ent.features[feature] === true;
}
