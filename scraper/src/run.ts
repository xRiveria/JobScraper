// Scraper entry point. Run on schedule from GitHub Actions:
//
//   npm run scrape -w @aggregator/scraper
//
// Writes a single output file at `data/jobs.json` (repo root).
// The workflow then force-pushes that file onto an orphan `data` branch
// so the git history never grows (each push replaces the prior commit).
//
// The published artifact is consumed by the client as a CDN-cached JSON:
//   https://raw.githubusercontent.com/<owner>/<repo>/data/jobs.json
//
// Scope (Phase 1): Singapore postings, last 30 days only. Adding regions or
// extending the window is a one-line change to POSTED_WITHIN_DAYS below.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "@aggregator/shared";
import { scrapeMcf } from "./sources/mcf.js";
import { scrapeSeek } from "./sources/seek.js";
import { scrapeGovtech } from "./sources/govtech.js";
import { dedupeJobs, type MergeRecord } from "./dedupe.js";

const WINDOW_DAYS = 30;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../../data/jobs.json");
const MERGES_PATH = resolve(__dirname, "../../data/merges.md");

/** Render the merge log as a human-scannable Markdown report. One section per
 *  merge event so you can spot false positives by skimming. */
function formatMergeReport(
  log: MergeRecord[],
  generatedAt: Date,
): string {
  const lines: string[] = [];
  lines.push(`# Merge report`);
  lines.push("");
  lines.push(`Generated ${generatedAt.toISOString()} — ${log.length} merge event(s).`);
  lines.push("");
  lines.push(
    `Each section shows one merge event: the canonical record that was kept`
      + ` and the records that were folded into it. Use this to audit whether`
      + ` the dedup pass is collapsing genuinely-duplicate postings or`
      + ` over-merging distinct roles.`,
  );
  lines.push("");
  log.forEach((m, i) => {
    lines.push(`## Merge ${i + 1} (${m.pass})`);
    lines.push("");
    lines.push(`- **Kept** [${m.kept.source}] ${m.kept.title} — ${m.kept.company}`);
    lines.push(`  - ${m.kept.url}`);
    m.merged.forEach((l, j) => {
      lines.push(`- **Merged ${j + 1}** [${l.source}] ${l.title} — ${l.company}`);
      lines.push(`  - ${l.url}`);
    });
    lines.push("");
  });
  return lines.join("\n");
}

interface Manifest {
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  /** Number of days back from `generatedAt` included. */
  windowDays: number;
  /** Per-source raw counts before dedupe (debug / health checks). */
  sourceCounts: Record<string, number>;
  /** Final job count after dedupe + filter. */
  total: number;
  /** Number of cross-source duplicates merged. */
  dedupedCount: number;
  /** Per-source-overlap breakdown — surface here so you can spot dedup
   *  regressions just by diffing two days of meta. */
  sourceMergeStats: {
    mcfAndSeek: number;
    mcfAndGovtech: number;
    seekAndGovtech: number;
    allThree: number;
  };
  /** Schema version — bump when we change Job shape; client checks this. */
  schemaVersion: 1;
  /** The jobs themselves, sorted by postedDate desc. */
  jobs: Job[];
}

async function safeRun(name: string, fn: () => Promise<Job[]>): Promise<Job[]> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[${name}] FAILED:`, e);
    // A single failed source shouldn't tank the whole snapshot. Return [],
    // log loudly, and let the dedupe step proceed with the others.
    return [];
  }
}

async function main(): Promise<void> {
  const generatedAt = new Date();
  console.log(`Scraping all available jobs from each source`);

  // Run sources in parallel — they're independent and most of the wall-time
  // is upstream HTTP latency. Internal politeness delays still apply per-source.
  const [mcfJobs, seekJobs, govtechJobs] = await Promise.all([
    safeRun("mcf", () => scrapeMcf()),
    safeRun("seek", () => scrapeSeek()),
    safeRun("govtech", () => scrapeGovtech()),
  ]);

  const sourceCounts = {
    mcf: mcfJobs.length,
    seek: seekJobs.length,
    govtech: govtechJobs.length,
  };
  console.log("Per-source counts:", sourceCounts);

  const { unique, stats: dedupeStats, mergeLog } = dedupeJobs([
    ...mcfJobs,
    ...seekJobs,
    ...govtechJobs,
  ]);
  console.log("Dedupe stats:", dedupeStats);

  // Sort newest first — the client treats this file as already-sorted.
  unique.sort((a, b) => {
    const ta = a.postedDate ? new Date(a.postedDate).getTime() : 0;
    const tb = b.postedDate ? new Date(b.postedDate).getTime() : 0;
    return tb - ta;
  });

  const manifest: Manifest = {
    generatedAt: generatedAt.toISOString(),
    windowDays: WINDOW_DAYS,
    sourceCounts,
    total: unique.length,
    dedupedCount: dedupeStats.dupes,
    sourceMergeStats: dedupeStats.merges,
    schemaVersion: 1,
    jobs: unique,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(manifest));
  const sizeMb = (JSON.stringify(manifest).length / 1024 / 1024).toFixed(2);
  console.log(
    `Wrote ${unique.length} jobs (${dedupeStats.dupes} dupes merged) to ${OUT_PATH} — ${sizeMb} MB`,
  );

  // Merge audit report — written alongside jobs.json so it ships in the same
  // orphan-branch commit and can be eyeballed from GitHub directly.
  await writeFile(MERGES_PATH, formatMergeReport(mergeLog, generatedAt));
  console.log(`Wrote ${mergeLog.length} merge event(s) to ${MERGES_PATH}`);
}

main().catch((e) => {
  console.error("Scraper failed:", e);
  process.exit(1);
});
