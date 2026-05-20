import { Hono } from "hono";
import type {
  Job,
  JobSearchRequest,
  JobSearchResponse,
} from "@aggregator/shared";
import { POSTED_WITHIN_DAYS } from "@aggregator/shared";
import { mcfGetJob, mcfSearch } from "../lib/mcf.js";
import { seekGetJob, seekSearch } from "../lib/seek.js";

/** Fetch one page from each source in parallel, merging into a single
 *  normalized result set. Failures from one source don't sink the request —
 *  we log and return what we got. */
async function multiSourceSearch(
  req: JobSearchRequest,
  page: number,
  limit: number,
): Promise<{ results: Job[]; total: number; exhaustedSources: number; totalSources: number }> {
  const sourceCalls = [
    mcfSearch({ ...req, page, limit }).then(
      (r) => ({ ok: true as const, src: "mcf", page: r.normalized }),
      (e: unknown) => ({ ok: false as const, src: "mcf", err: e }),
    ),
    seekSearch({ ...req, page, limit }).then(
      (r) => ({ ok: true as const, src: "seek", page: r.normalized }),
      (e: unknown) => ({ ok: false as const, src: "seek", err: e }),
    ),
  ];
  const settled = await Promise.all(sourceCalls);

  const results: Job[] = [];
  let total = 0;
  let exhaustedSources = 0;
  const totalSources = settled.length;
  for (const s of settled) {
    if (!s.ok) {
      console.warn(`[aggregator] ${s.src} failed:`, s.err);
      exhaustedSources++; // treat as exhausted so we don't loop forever on a dead source
      continue;
    }
    results.push(...s.page.results);
    total += s.page.total;
    // Heuristic: if this source returned fewer than requested, it's done.
    if (s.page.results.length < limit) exhaustedSources++;
  }
  return { results, total, exhaustedSources, totalSources };
}

export const jobsRoute = new Hono();

/** Per-request bounds on how aggressively we'll scan upstream to fill a
 *  visible page. Hitting these caps means we stop and report `hasMore: true`
 *  (or `exhausted: false`) — never silently return partial pages.
 *
 *  Latency budget: at ~200ms per upstream fetch and a 100-result limit
 *  upstream, 10 fetches = ~2s worst case and 1,000 raw jobs scanned. */
const MAX_UPSTREAM_PAGES = 10;
const UPSTREAM_LIMIT = 100;

function applyLocalFilters(jobs: Job[], req: JobSearchRequest): Job[] {
  const f = req.filters ?? {};
  let out = jobs;

  if (f.employmentType?.length) {
    const want = new Set(f.employmentType);
    out = out.filter((j) => j.employmentTypes.some((t) => want.has(t)));
  }
  if (f.seniority?.length) {
    const want = new Set(f.seniority);
    out = out.filter((j) => j.seniority.some((s) => want.has(s)));
  }
  if (f.category?.length) {
    const want = new Set(f.category);
    out = out.filter((j) => j.categories.some((c) => want.has(c)));
  }
  if (f.salaryMin != null) {
    const min = f.salaryMin;
    out = out.filter((j) => {
      const max = j.salary?.max ?? j.salary?.min;
      return max != null && max >= min;
    });
  }
  if (f.salaryMax != null) {
    const max = f.salaryMax;
    out = out.filter((j) => {
      const lo = j.salary?.min ?? j.salary?.max;
      return lo != null && lo <= max;
    });
  }
  if (f.postedWithin) {
    const cutoff = Date.now() - POSTED_WITHIN_DAYS[f.postedWithin] * 86_400_000;
    out = out.filter((j) => {
      if (!j.postedDate) return false;
      const t = new Date(j.postedDate).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  return out;
}

/** Has the caller actually applied any local filter that could trim results?
 *  When no filters are active we can skip the buffering loop and pass the
 *  upstream page through 1:1 — keeps the common case fast. */
function hasAnyLocalFilter(req: JobSearchRequest): boolean {
  const f = req.filters ?? {};
  return (
    !!f.employmentType?.length ||
    !!f.seniority?.length ||
    !!f.category?.length ||
    f.salaryMin != null ||
    f.salaryMax != null ||
    !!f.postedWithin
  );
}

/** De-dupe by Job.id across upstream pages. Upstream pagination is generally
 *  stable but we belt-and-braces this in case a job appears twice. */
function dedupe(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const j of jobs) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
  return out;
}

async function aggregateSearch(
  req: JobSearchRequest,
): Promise<JobSearchResponse> {
  const visiblePage = Math.max(0, req.page ?? 0);
  const visibleLimit = Math.min(req.limit ?? 20, 100);

  // Fast path: no local filters → fan out one page to each source and merge.
  // We over-request (visibleLimit from each) and slice locally so the merged
  // page is filled even when one source is sparse.
  if (!hasAnyLocalFilter(req)) {
    const merged = await multiSourceSearch(req, visiblePage, visibleLimit);
    const deduped = dedupe(merged.results);
    const slice = deduped.slice(0, visibleLimit);
    const exhausted = merged.exhaustedSources === merged.totalSources;
    return {
      results: slice,
      total: merged.total,
      knownCount: deduped.length,
      exhausted,
      hasMore: deduped.length > visibleLimit || !exhausted,
      upstreamPagesFetched: 1,
      page: visiblePage,
      limit: visibleLimit,
    };
  }

  // Slow path: scan upstream pages until the visible window is filled or we
  // run out of upstream / hit the cap.
  const accumulated: Job[] = [];
  let upstreamPage = 0;
  let upstreamTotal = 0;
  let exhausted = false;
  let pagesFetched = 0;
  const targetCount = (visiblePage + 1) * visibleLimit;

  while (accumulated.length < targetCount && pagesFetched < MAX_UPSTREAM_PAGES) {
    const merged = await multiSourceSearch(req, upstreamPage, UPSTREAM_LIMIT);
    pagesFetched++;
    if (pagesFetched === 1) upstreamTotal = merged.total;

    const filtered = applyLocalFilters(merged.results, req);
    accumulated.push(...filtered);

    // All sources reported fewer than requested → nothing left upstream.
    if (merged.exhaustedSources === merged.totalSources) {
      exhausted = true;
      break;
    }
    upstreamPage++;
  }

  const deduped = dedupe(accumulated);
  const start = visiblePage * visibleLimit;
  const end = start + visibleLimit;
  const slice = deduped.slice(start, end);

  return {
    results: slice,
    total: upstreamTotal,
    knownCount: deduped.length,
    exhausted,
    // hasMore semantics:
    //  - We may have more items already accumulated past the current window, OR
    //  - We hit the upstream-pages cap before exhausting the source.
    hasMore: deduped.length > end || !exhausted,
    upstreamPagesFetched: pagesFetched,
    page: visiblePage,
    limit: visibleLimit,
  };
}

jobsRoute.post("/search", async (c) => {
  let body: JobSearchRequest;
  try {
    body = (await c.req.json()) as JobSearchRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await aggregateSearch(body);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Upstream search failed", detail: message }, 502);
  }
});

/** Detail proxy unchanged. */
jobsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  // Composite ids look like "mcf:<uuid>" or "seek:<numeric>". Bare ids
  // (no colon) are assumed to be MCF for backward compat with early bookmarks.
  const [source, sourceId] = id.includes(":") ? id.split(":", 2) : ["mcf", id];
  if (!sourceId) {
    return c.json({ error: `Unsupported job id: ${id}` }, 400);
  }

  try {
    let job;
    if (source === "mcf") {
      job = await mcfGetJob(sourceId);
    } else if (source === "seek") {
      job = await seekGetJob(sourceId);
    } else {
      // govtech jobs are fully embedded in the snapshot — no live detail
      // endpoint exists (opengovsg only publishes the daily JSON dump).
      // Client should fall back to the snapshot for these ids.
      return c.json({ error: `No live detail endpoint for source: ${source}` }, 400);
    }
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Upstream fetch failed", detail: message }, 502);
  }
});

/** Debug-only: raw + normalized side by side, no local filters or buffering. */
jobsRoute.post("/search/raw", async (c) => {
  let body: JobSearchRequest;
  try {
    body = (await c.req.json()) as JobSearchRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const result = await mcfSearch(body);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Upstream search failed", detail: message }, 502);
  }
});
