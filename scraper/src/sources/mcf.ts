// Paginated MCF scrape with category slicing.
//
// MCF's API enforces a hard `page * limit <= 10000` cap and returns HTTP 418
// ("Pagination limit reached.") beyond it. Total SG inventory is ~70k, so a
// single keyword-less query can never reach more than ~14% of the corpus.
//
// Workaround: slice the corpus by the `categories` body field (verified shape
// from a captured XHR: `categories: ["Information Technology"]`). Each MCF
// category is a manageable sub-corpus — almost all are well under 10k. We
// paginate per-slice and dedupe across slices by `sourceId`, since a job can
// be tagged with multiple categories and will appear in more than one slice.
//
// If a single slice STILL exceeds 10k we log a warning — that category needs
// further sub-slicing (employment-type, posting-date window, etc.).

import type { Job } from "@aggregator/shared";
import { mcfSearch } from "../../../server/src/lib/mcf.js";

const PAGE_SIZE = 100;
/** MCF hard cap is page*limit <= 10000. With limit=100 that's pages 0..99. */
const MAX_PAGES_PER_SLICE = 100;
const REQUEST_DELAY_MS = 200;

/** MCF category names, as they appear in the sidebar UI and in the
 *  `categories: [...]` request body. Covers the full taxonomy as of May 2026.
 *  If MCF adds a category, jobs in it will still be discovered via the
 *  un-sliced fallback pass (first 10k) — but for completeness, add it here. */
const MCF_CATEGORIES = [
  "Accounting / Auditing / Taxation",
  "Admin / Secretarial",
  "Advertising / Media",
  "Architecture / Interior Design",
  "Banking and Finance",
  "Building and Construction",
  "Consulting",
  "Customer Service",
  "Design",
  "Education and Training",
  "Engineering",
  "Entertainment",
  "Environment / Health",
  "Events / Promotions",
  "F&B",
  "General Management",
  "General Work",
  "Healthcare / Pharmaceutical",
  "Hospitality",
  "Human Resources",
  "Information Technology",
  "Insurance",
  "Legal",
  "Logistics / Supply Chain",
  "Manufacturing",
  "Marketing / Public Relations",
  "Medical / Therapy Services",
  "Personal Care / Beauty",
  "Professional Services",
  "Public / Civil Service",
  "Purchasing / Merchandising",
  "Real Estate / Property Management",
  "Repair and Maintenance",
  "Risk Management",
  "Sales / Retail",
  "Sciences / Laboratory / R&D",
  "Security and Investigation",
  "Social Services",
  "Telecommunications",
  "Travel / Tourism",
  "Others",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScrapeOptions {
  /** Currently unused — kept so the call signature stays uniform across
   *  sources. We don't filter by date here. */
  postedAfter?: string;
}

/** Walk a single slice (one category, or no category for the un-sliced pass)
 *  up to the MCF hard cap. Returns the page total reported by MCF so the
 *  caller can warn when a slice is over-cap. */
async function scrapeSlice(
  label: string,
  category: string | null,
): Promise<{ jobs: Job[]; upstreamTotal: number; capped: boolean }> {
  const out: Job[] = [];
  let upstreamTotal = 0;
  const filters = category ? { category: [category] } : undefined;

  for (let page = 0; page < MAX_PAGES_PER_SLICE; page++) {
    let normalized;
    try {
      ({ normalized } = await mcfSearch({ page, limit: PAGE_SIZE, filters }));
    } catch (e) {
      console.warn(`[mcf:${label}] page ${page + 1} failed:`, e);
      break;
    }
    upstreamTotal = normalized.total;
    if (!normalized.results.length) break;

    out.push(...normalized.results);
    if ((page + 1) * PAGE_SIZE >= upstreamTotal) break;
    await sleep(REQUEST_DELAY_MS);
  }

  const capped = upstreamTotal > MAX_PAGES_PER_SLICE * PAGE_SIZE;
  console.log(
    `[mcf:${label}] ${out.length} jobs (upstream total ${upstreamTotal})${capped ? " ⚠ CAPPED — slice further" : ""}`,
  );
  return { jobs: out, upstreamTotal, capped };
}

export async function scrapeMcf(_opts: ScrapeOptions = {}): Promise<Job[]> {
  void _opts;

  // Dedupe by sourceId — a job tagged with N categories appears in N slices.
  const seen = new Map<string, Job>();
  let cappedSlices = 0;

  for (const category of MCF_CATEGORIES) {
    const { jobs, capped } = await scrapeSlice(category, category);
    if (capped) cappedSlices++;
    for (const j of jobs) {
      if (!seen.has(j.sourceId)) seen.set(j.sourceId, j);
    }
  }

  if (cappedSlices > 0) {
    console.warn(
      `[mcf] ${cappedSlices} slice(s) hit the 10k cap — those categories need finer sub-slicing.`,
    );
  }
  console.log(`[mcf] ${seen.size} unique jobs after deduping across ${MCF_CATEGORIES.length} categories.`);

  return Array.from(seen.values());
}
