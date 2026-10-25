import { redact } from './security.js';

const SENSITIVE = /pass|secret|token|apikey|api_key|credential/i;

function scrub(details) {
  if (details == null) return null;
  const walk = (v, k) => {
    if (k && SENSITIVE.test(k) && typeof v === 'string') return '[redacted]';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]));
    return typeof v === 'string' ? redact(v) : v;
  };
  return JSON.stringify(walk(details)).slice(0, 8000);
}

/** Append-only audit trail for administrative and security-relevant actions. */
export function audit(db, { actor, subjectUserId, action, resourceType, resourceId, outcome = 'success', details, ip }) {
  db.prepare(`INSERT INTO audit_log (actor_user_id, actor_email, subject_user_id, action, resource_type, resource_id, outcome, details, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    actor?.id ?? null, actor?.email ?? null, subjectUserId ?? null, action, resourceType ?? null,
    resourceId == null ? null : String(resourceId), outcome, scrub(details), ip ?? null, Date.now(),
  );
}
