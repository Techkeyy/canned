/**
 * Rate limiting for the public write endpoints.
 *
 * The ownership claim flow is the only place a stranger can make Canned do
 * work and hold state, so it is the only place worth limiting. The shape of
 * the limit matters as much as the numbers:
 *
 *   - Limiting only by IP lets one host grind every agent from a rotating
 *     proxy pool.
 *   - Limiting only by target lets one IP grind every agent in turn.
 *
 * So both are counted, and the stricter verdict wins. Verification is limited
 * harder than issuance because a challenge is single use: honest users need a
 * handful of attempts, and anyone needing hundreds is guessing.
 *
 * This is deliberately not a global cap. A global counter is itself the denial
 * of service, since one attacker tripping it locks out everybody.
 */

/** Sliding windows, chosen to be generous for a person and useless for a grinder. */
export const RATE_LIMITS = Object.freeze({
  challengePerIp: { limit: 20, windowMs: 10 * 60 * 1000 },
  challengePerAddress: { limit: 10, windowMs: 10 * 60 * 1000 },
  challengePerIdentity: { limit: 30, windowMs: 10 * 60 * 1000 },
  verifyPerIp: { limit: 15, windowMs: 10 * 60 * 1000 },
  verifyPerIdentity: { limit: 10, windowMs: 10 * 60 * 1000 },
  submitPerIp: { limit: 20, windowMs: 10 * 60 * 1000 },
});

/** Bound the table itself, so counting callers cannot become the memory leak. */
export const MAX_TRACKED_KEYS = 20_000;

export class SlidingWindowLimiter {
  constructor({ limits = RATE_LIMITS, maxKeys = MAX_TRACKED_KEYS } = {}) {
    this.limits = limits;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /** Drop windows that have fully expired. Cheap, and keeps the map honest. */
  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  /**
   * Count one request against a named bucket.
   *
   * Returns what happened rather than throwing, because a caller usually wants
   * to check several buckets and report the one that actually tripped.
   */
  hit(bucket, subject, now = Date.now()) {
    const rule = this.limits[bucket];
    if (!rule) return { allowed: true, bucket, remaining: Infinity, resetAt: now };
    const key = `${bucket}:${String(subject ?? "unknown").toLowerCase()}`;

    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + rule.windowMs };

    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      this.prune(now);
      // Still full after pruning: refuse rather than grow without bound. The
      // safe direction under pressure is to say no.
      if (this.hits.size >= this.maxKeys) {
        return { allowed: false, bucket, remaining: 0, resetAt: now + rule.windowMs, reason: "limiter_saturated" };
      }
    }

    entry.count += 1;
    this.hits.set(key, entry);
    const allowed = entry.count <= rule.limit;
    return {
      allowed,
      bucket,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  /**
   * Count against several buckets at once and report the first refusal.
   *
   * Every bucket is counted even when an earlier one already refused, so a
   * caller cannot avoid one counter by tripping another first.
   */
  check(checks, now = Date.now()) {
    const results = checks
      .filter(([, subject]) => subject !== undefined && subject !== null && subject !== "")
      .map(([bucket, subject]) => this.hit(bucket, subject, now));
    const refused = results.find((result) => !result.allowed) || null;
    return { allowed: !refused, refused, results };
  }
}

/**
 * The client address, taken from the socket by default.
 *
 * A forwarded header is only believed when the deployment says it sits behind
 * a proxy, because otherwise anyone can set it and every per-IP limit becomes
 * decorative.
 */
export function clientKey(request, { trustProxy = process.env.CANNED_TRUST_PROXY === "true" } = {}) {
  if (trustProxy) {
    const forwarded = request?.headers?.["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return request?.socket?.remoteAddress || "unknown";
}
