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
import { seekGetJob, seekSearch } from "../../../server/src/lib/seek.js";

const PAGE_SIZE = 32; // SEEK caps pageSize at 32 regardless of what we send
const MAX_PAGES = 400; // 12.8k jobs ceiling
const REQUEST_DELAY_MS = 300;

/** Detail-enrichment tuning. Conservative defaults — bump concurrency cautiously,
 *  SEEK's gateway responds to abuse with UNSTABLE_QUERY_ERROR sprays. */
const DETAIL_CONCURRENCY = 4;
const DETAIL_POLITENESS_MS = 150;
/** How often to log progress during enrichment. */
const DETAIL_LOG_EVERY = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 *  non-fatal — we keep the thin listing entry rather than tanking the run. */
async function enrichOne(job: Job): Promise<Job> {
  try {
    const detail = await seekGetJob(job.sourceId);
    if (!detail) return job;
    return mergeListingAndDetail(job, detail);
  } catch (e) {
    // Common cases: job was removed between listing scan and detail fetch
    // (404 / isExpired), gateway hiccup, transient rate limit. Log and skip.
    console.warn(`[seek] enrich ${job.sourceId} failed:`, e instanceof Error ? e.message : e);
    return job;
  }
}

/** Concurrent enrichment pool. Workers pull from a shared cursor so faster
 *  responses naturally pick up more work than slow ones — no batching cliff. */
async function enrichAll(jobs: Job[]): Promise<Job[]> {
  const out: Job[] = new Array(jobs.length);
  let nextIdx = 0;
  let completed = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++;
      if (i >= jobs.length) return;
      const before = jobs[i]!;
      const after = await enrichOne(before);
      out[i] = after;
      completed++;
      // Count as enriched only when the description actually grew —
      // a no-op return means the listing was unchanged (likely a fetch failure).
      if (
        (after.descriptionText?.length ?? 0) <=
        (before.descriptionText?.length ?? 0)
      ) {
        failed++;
      }
      if (completed % DETAIL_LOG_EVERY === 0) {
        console.log(
          `[seek] enriched ${completed}/${jobs.length} (failed ${failed})`,
        );
      }
      await sleep(DETAIL_POLITENESS_MS);
    }
  }

  await Promise.all(
    Array.from({ length: DETAIL_CONCURRENCY }, () => worker()),
  );
  console.log(
    `[seek] enrichment complete: ${completed - failed}/${completed} got full descriptions`,
  );
  return out;
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

  // ---- Phase 2: detail enrichment ----
  console.log(`[seek] enriching ${listings.length} jobs with full descriptions…`);
  return enrichAll(listings);
}
