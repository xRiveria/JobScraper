// Paginated SEEK / JobStreet SG scrape. Two phases:
//
//   1. Listing scan — walk the search results until exhausted (no totalCount
//      exposed in our query; a partial page is the EOF signal).
//   2. Detail enrichment — for each result, hit the GraphQL `jobDetails`
//      endpoint to backfill the full HTML description. SEEK's search payload
//      only carries a ~150-char teaser + bullets, so without this pass the
//      snapshot ships jobs with no readable JD.
//
// Enrichment is concurrent (N workers) with per-request politeness — at
// SEEK's SG inventory (~10-15k jobs) sequential @ 300ms/req would take ~1h.
// 4 workers @ 150ms each completes in ~5-10 min and stays well under
// observed rate-limit thresholds.

import type { Job } from "@aggregator/shared";
import { seekGetJob, seekGetJobViaHtml, seekSearch } from "../../../server/src/lib/seek.js";

const PAGE_SIZE = 32; // SEEK caps pageSize at 32 regardless of what we send
const MAX_PAGES = 400; // 12.8k jobs ceiling
const REQUEST_DELAY_MS = 300;

/** Detail-enrichment tuning. SEEK is fronted by Cloudflare bot management,
 *  which fingerprints request cadence. >5 req/s sustained triggers `Just a
 *  moment...` HTML challenges (403) for minutes at a time. Concurrent 4 + 150ms
 *  was ~26 req/s — too hot. New defaults aim for ~3 req/s with jitter so the
 *  cadence doesn't look mechanical.
 *
 *  Tradeoff: 12.8k jobs now take ~70 min instead of ~10 min. Acceptable when
 *  the run is daily and the alternative is 17% data loss. */
const DETAIL_CONCURRENCY = 2;
const DETAIL_POLITENESS_MS = 600;
/** Random jitter applied to each delay: ±this fraction of POLITENESS_MS. */
const DETAIL_JITTER = 0.4;
/** Retries per job on transient failures (403 / "An error occurred"). */
const DETAIL_MAX_RETRIES = 2;
/** Base backoff between retries; doubles each attempt. */
const DETAIL_RETRY_BACKOFF_MS = 8000;
/** When we see N failures in a 60-job sliding window, pause for cooldown.
 *  Cloudflare lockouts last ~1-3 min so this lets the bucket drain before
 *  hammering further. */
const DETAIL_BURST_FAIL_THRESHOLD = 8;
const DETAIL_BURST_WINDOW = 60;
const DETAIL_COOLDOWN_MS = 90_000;
/** How often to log progress during enrichment. */
const DETAIL_LOG_EVERY = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitteredDelay = (): number => {
  const jitter = DETAIL_POLITENESS_MS * DETAIL_JITTER * (Math.random() * 2 - 1);
  return Math.max(50, DETAIL_POLITENESS_MS + jitter);
};

/** Should we treat this error as worth retrying? 403s (Cloudflare) and
 *  generic gateway errors recover after a cooldown; explicit 404s do not. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("404")) return false;
  if (msg.includes("403")) return true;
  if (msg.toLowerCase().includes("an error occurred")) return true;
  if (msg.includes("UNSTABLE_QUERY_ERROR")) return true;
  if (msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) return true;
  return false;
}

export interface ScrapeOptions {
  postedAfter?: string;
}

/** Merge a search-payload listing with a detail-endpoint payload. The detail
 *  response is authoritative for description fields (the whole point of the
 *  pass); everything else falls back to the listing. We don't blindly spread
 *  the detail Job because the listing has source-of-truth values for fields
 *  the detail query doesn't return (employmentTypes mapped from workTypes,
 *  the categories array, the original `id` composite). */
function mergeListingAndDetail(listing: Job, detail: Job): Job {
  return {
    ...listing,
    description: detail.description || listing.description,
    descriptionText: detail.descriptionText || listing.descriptionText,
    location: detail.location || listing.location,
    salary: detail.salary ?? listing.salary,
    applicantCount: detail.applicantCount ?? listing.applicantCount,
    expiryDate: detail.expiryDate ?? listing.expiryDate,
  };
}

/** Enrich a single listing with its detail-endpoint description. Failure is
 *  non-fatal — we keep the thin listing entry rather than tanking the run.
 *  Transient errors (403 from Cloudflare, generic GraphQL "An error occurred")
 *  are retried with exponential backoff; permanent errors (404, parse failures)
 *  bail immediately to avoid wasting the retry budget. */
async function enrichOne(job: Job): Promise<Job> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DETAIL_MAX_RETRIES; attempt++) {
    try {
      // PRIMARY: the SEO HTML page. Embeds the same Apollo data the GraphQL
      // detail call returns, but isn't behind the query-allowlist gateway
      // and has far looser Cloudflare rate limits (SEO traffic is expected).
      // This avoids the entire UNSTABLE_QUERY_ERROR class of failures.
      const fromHtml = await seekGetJobViaHtml(job.sourceId);
      if (fromHtml) return mergeListingAndDetail(job, fromHtml);

      // SECONDARY: fall through to the GraphQL detail call. Used only when
      // the HTML page returned 200 but neither SEEK_REDUX_DATA nor JSON-LD
      // could be parsed (rare — usually means SEEK ran an A/B that swapped
      // the SPA shell). Keeps the system resilient to template revisions.
      const detail = await seekGetJob(job.sourceId);
      if (!detail) return job;
      return mergeListingAndDetail(job, detail);
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === DETAIL_MAX_RETRIES) break;
      // Exponential backoff with jitter so retries don't all land at once.
      const base = DETAIL_RETRY_BACKOFF_MS * Math.pow(2, attempt);
      const jitter = base * 0.3 * (Math.random() * 2 - 1);
      await sleep(base + jitter);
    }
  }
  console.warn(
    `[seek] enrich ${job.sourceId} failed:`,
    lastErr instanceof Error ? lastErr.message : lastErr,
  );
  return job;
}

/** Concurrent enrichment pool with burst-failure cooldown. Workers pull from
 *  a shared cursor; a rolling failure window triggers a full-pool pause when
 *  Cloudflare flips into challenge mode, letting the bucket drain before
 *  retrying. Faster than aborting and retrying the entire run. */
async function enrichAll(jobs: Job[]): Promise<Job[]> {
  const out: Job[] = new Array(jobs.length);
  let nextIdx = 0;
  let completed = 0;
  let failed = 0;
  // Rolling window of recent outcomes (true = failure). When threshold is
  // exceeded we pause every worker for DETAIL_COOLDOWN_MS.
  const recent: boolean[] = [];
  let cooldownUntil = 0;

  function shouldCoolDown(): boolean {
    if (recent.length < DETAIL_BURST_WINDOW) return false;
    const fails = recent.filter(Boolean).length;
    return fails >= DETAIL_BURST_FAIL_THRESHOLD;
  }

  async function worker(workerId: number): Promise<void> {
    while (true) {
      // Cooldown gate — multiple workers may stall here simultaneously, which
      // is exactly what we want (full pool pause).
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);

      const i = nextIdx++;
      if (i >= jobs.length) return;
      const before = jobs[i]!;
      const after = await enrichOne(before);
      out[i] = after;
      completed++;

      const didFail =
        (after.descriptionText?.length ?? 0) <=
        (before.descriptionText?.length ?? 0);
      if (didFail) failed++;
      recent.push(didFail);
      if (recent.length > DETAIL_BURST_WINDOW) recent.shift();

      if (shouldCoolDown() && Date.now() >= cooldownUntil) {
        cooldownUntil = Date.now() + DETAIL_COOLDOWN_MS;
        recent.length = 0; // reset window so we don't immediately re-trigger
        console.warn(
          `[seek] burst-failure detected (worker ${workerId}); cooling down ${Math.round(DETAIL_COOLDOWN_MS / 1000)}s`,
        );
      }

      if (completed % DETAIL_LOG_EVERY === 0) {
        console.log(
          `[seek] enriched ${completed}/${jobs.length} (failed ${failed})`,
        );
      }
      await sleep(jitteredDelay());
    }
  }

  await Promise.all(
    Array.from({ length: DETAIL_CONCURRENCY }, (_, i) => worker(i)),
  );
  console.log(
    `[seek] enrichment complete: ${completed - failed}/${completed} got full descriptions`,
  );
  return out;
}

/** On-disk cache of previously-enriched SEEK descriptions, keyed by sourceId.
 *  SEEK job descriptions almost never change once posted — re-fetching the
 *  same job's description every day is pure waste and the main cause of our
 *  Cloudflare interaction. Persisting these makes day-2+ scrapes hit the
 *  detail endpoint only for genuinely new jobs.
 *
 *  Cache lives at `data/seek-detail-cache.json`. Each entry is a minimal
 *  description payload we can merge back over a listing. Size is dominated
 *  by description HTML; expect ~3-10 KB per entry → 50-150 MB at full SG
 *  scale. Acceptable for a build artifact; if it ever gets uncomfortable
 *  we add TTL eviction. */
interface CachedDetail {
  description: string;
  descriptionText?: string;
  location?: string;
  salary?: Job["salary"];
  applicantCount?: number;
  expiryDate?: string;
  cachedAt: string;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../../../data/seek-detail-cache.json");

function loadCache(): Map<string, CachedDetail> {
  if (!existsSync(CACHE_PATH)) return new Map();
  try {
    const raw = readFileSync(CACHE_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, CachedDetail>;
    return new Map(Object.entries(obj));
  } catch (e) {
    console.warn("[seek] failed to load detail cache; starting fresh:", e);
    return new Map();
  }
}

function saveCache(cache: Map<string, CachedDetail>): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const obj = Object.fromEntries(cache);
  writeFileSync(CACHE_PATH, JSON.stringify(obj));
}

export async function scrapeSeek(_opts: ScrapeOptions = {}): Promise<Job[]> {
  void _opts;
  const listings: Job[] = [];

  // ---- Phase 1: listing scan ----
  for (let page = 0; page < MAX_PAGES; page++) {
    let normalized;
    try {
      ({ normalized } = await seekSearch({ page, limit: PAGE_SIZE }));
    } catch (e) {
      console.warn(`[seek] page ${page + 1} failed:`, e);
      break;
    }
    const got = normalized.results.length;
    if (!got) break;

    listings.push(...normalized.results);
    console.log(`[seek] page ${page + 1}: +${got} (cumulative ${listings.length})`);

    // SEEK doesn't expose totalCount in our query — a partial page is the
    // signal we've reached the end of results.
    if (got < PAGE_SIZE) break;
    await sleep(REQUEST_DELAY_MS);
  }

  if (!listings.length) return listings;

  // ---- Phase 2: detail enrichment with cache ----
  const cache = loadCache();
  console.log(`[seek] detail cache: ${cache.size} entries loaded`);

  // Apply cached descriptions immediately; only the cache-misses go through
  // the network-bound enrichment pool.
  const hydrated: Job[] = [];
  const needsFetch: Job[] = [];
  for (const j of listings) {
    const cached = cache.get(j.sourceId);
    if (cached) {
      hydrated.push({
        ...j,
        description: cached.description || j.description,
        descriptionText: cached.descriptionText ?? j.descriptionText,
        location: cached.location || j.location,
        salary: cached.salary ?? j.salary,
        applicantCount: cached.applicantCount ?? j.applicantCount,
        expiryDate: cached.expiryDate ?? j.expiryDate,
      });
    } else {
      needsFetch.push(j);
    }
  }

  console.log(
    `[seek] enriching ${needsFetch.length} new jobs (${hydrated.length} served from cache)…`,
  );
  const fetched = needsFetch.length ? await enrichAll(needsFetch) : [];

  // Update the cache with any newly-enriched descriptions. A no-op enrichment
  // (description didn't grow) means the fetch failed — don't cache those.
  for (let i = 0; i < needsFetch.length; i++) {
    const before = needsFetch[i]!;
    const after = fetched[i]!;
    const beforeLen = (before.descriptionText?.length ?? 0);
    const afterLen = (after.descriptionText?.length ?? 0);
    if (afterLen > beforeLen) {
      cache.set(after.sourceId, {
        description: after.description,
        descriptionText: after.descriptionText,
        location: after.location,
        salary: after.salary,
        applicantCount: after.applicantCount,
        expiryDate: after.expiryDate,
        cachedAt: new Date().toISOString(),
      });
    }
  }
  saveCache(cache);
  console.log(`[seek] detail cache: ${cache.size} entries saved`);

  return [...hydrated, ...fetched];
}
