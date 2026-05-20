// Paginated SEEK / JobStreet SG scrape. Same logic as MCF — walk until the
// source is exhausted or we hit the page cap. No date filtering at the
// adapter level; we keep everything and let the client filter.

import type { Job } from "@aggregator/shared";
import { seekSearch } from "../../../server/src/lib/seek.js";

const PAGE_SIZE = 32; // SEEK caps pageSize at 32 regardless of what we send
const MAX_PAGES = 400; // 12.8k jobs ceiling
const REQUEST_DELAY_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScrapeOptions {
  postedAfter?: string;
}

export async function scrapeSeek(_opts: ScrapeOptions = {}): Promise<Job[]> {
  void _opts;
  const out: Job[] = [];

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

    out.push(...normalized.results);
    console.log(`[seek] page ${page + 1}: +${got} (cumulative ${out.length})`);

    // SEEK doesn't expose totalCount in our query — a partial page is the
    // signal we've reached the end of results.
    if (got < PAGE_SIZE) break;
    await sleep(REQUEST_DELAY_MS);
  }

  return out;
}
