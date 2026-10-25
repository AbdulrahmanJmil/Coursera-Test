/** In-memory fixed-window rate limiter. Suitable for a single server process. */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** Returns { ok, retryAfterSec }. */
  hit(key, limit, windowMs, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    if (b.count > limit) return { ok: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
    return { ok: true };
  }

  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }

  close() {
    clearInterval(this.timer);
  }
}

// Limits per client IP (or per user where noted) per window.
export const RATE_LIMITS = {
  auth: { limit: 20, windowMs: 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  redeem: { limit: 10, windowMs: 10 * 60_000 },
  api: { limit: 240, windowMs: 60_000 },
  admin: { limit: 600, windowMs: 60_000 },
  ai: { limit: 6, windowMs: 60_000 },
  diagnostics: { limit: 30, windowMs: 60 * 60_000 },
};
