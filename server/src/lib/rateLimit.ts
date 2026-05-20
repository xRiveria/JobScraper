// Per-IP daily rate limiter for expensive AI routes. In-memory only; fine for
// a single-instance deploy. Move to Redis if you ever scale horizontally.
//
// Buckets are named so we can apply different quotas per route family:
//   - "sonnet" — tailor + cover letter (expensive model)
//   - "haiku"  — match score + ats fixers (cheap model)
//
// Counters reset at the next UTC midnight after first use. We don't try to
// be too clever here — a sliding window would be more fair but harder to
// reason about. "20 of these per day" is a clear user-facing promise.

import type { Context, Next } from "hono";

interface Counter {
  used: number;
  resetAt: number;
}

type Bucket = "sonnet" | "haiku";

const LIMITS: Record<Bucket, number> = {
  sonnet: 20, // tailor or cover letter (each call is ~$0.05–0.15)
  haiku: 200, // match score / ats fixers (each ~$0.001–0.005)
};

// Map<ip, Map<bucket, Counter>>
const counters = new Map<string, Map<Bucket, Counter>>();

function nextMidnightUtc(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function getClientIp(c: Context): string {
  // Behind a proxy / GH-deployed environment, prefer X-Forwarded-For.
  // First hop is the original client; everything after is proxies.
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  // Hono's c.env.remoteAddr varies by runtime; fall back to a constant so
  // local dev still rate-limits (would otherwise share one counter for all).
  return "local";
}

export function rateLimit(bucket: Bucket) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = getClientIp(c);
    const now = Date.now();

    let perIp = counters.get(ip);
    if (!perIp) {
      perIp = new Map();
      counters.set(ip, perIp);
    }
    let counter = perIp.get(bucket);
    if (!counter || counter.resetAt <= now) {
      counter = { used: 0, resetAt: nextMidnightUtc(now) };
      perIp.set(bucket, counter);
    }

    if (counter.used >= LIMITS[bucket]) {
      const retryAfterSec = Math.ceil((counter.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfterSec));
      c.header("X-RateLimit-Limit", String(LIMITS[bucket]));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.floor(counter.resetAt / 1000)));
      return c.json(
        {
          error: "Rate limit exceeded",
          detail: `You've used all ${LIMITS[bucket]} ${bucket} requests for today. Resets at midnight UTC.`,
          bucket,
          retryAfterSec,
        },
        429,
      );
    }

    counter.used++;
    c.header("X-RateLimit-Limit", String(LIMITS[bucket]));
    c.header("X-RateLimit-Remaining", String(LIMITS[bucket] - counter.used));
    c.header("X-RateLimit-Reset", String(Math.floor(counter.resetAt / 1000)));

    await next();
  };
}
