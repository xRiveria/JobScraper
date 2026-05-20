// Cross-source dedup. Same job often appears on multiple boards — a DBS
// posting hits MCF + JobStreet, a public-sector role hits MCF + GovTech.
// Source IDs differ, so we match on a normalized fingerprint.
//
// Strategy (two-pass, conservative):
//
//   Pass 1: Group by canonicalCompany(name). Within each company bucket,
//           sub-group by normalizeTitleForMatch(title) AND postedDate
//           proximity (must be within MERGE_WINDOW_DAYS). Anything with
//           >= 2 members is an exact-match merge group.
//
//   Pass 2: Among singletons left in each company bucket, run pairwise
//           token-overlap. tokenOverlap >= FUZZY_THRESHOLD AND posted
//           within window = fuzzy merge.
//
// Merging rule: highest-priority source wins as the canonical record.
// Missing-but-present-on-loser fields (salary, seniority, skills) get
// backfilled. Arrays union. All loser source URLs land in winner.alsoOn.
//
// What we DELIBERATELY don't do:
//  - Cross-company matching. If canonical names differ, treat as different
//    jobs. Aliases in normalize.ts handle the known collapses.
//  - LLM-assisted matching. Token overlap covers ~95% at $0 cost.
//  - Salary-based discrimination. Two listings can disagree on salary band
//    yet still be the same job (one outdated, one updated). Don't gate.

import type { Job, JobSource } from "@aggregator/shared";
import {
  canonicalCompany,
  daysBetween,
  descriptionContainment,
  descriptionFingerprint,
  normalizeTitleForMatch,
  titleTokens,
  tokenOverlap,
} from "./normalize.js";

/** Priority for picking the canonical record on collision. Higher = wins.
 *  GovTech first because its structured data is cleanest (parsed salary,
 *  explicit categories, real expiry dates). MCF second for full HTML
 *  descriptions. SEEK last because the search payload is teaser-only. */
const SOURCE_PRIORITY: Record<JobSource, number> = {
  govtech: 3,
  mcf: 2,
  seek: 1,
  linkedin: 0,
  indeed: 0,
};

/** Merge candidates must be posted within this many days of each other.
 *  Prevents "Software Engineer at DBS" from 2024 colliding with a 2026
 *  reposting that happens to share a title. 30d matches our scrape window. */
const MERGE_WINDOW_DAYS = 30;

/** Jaccard threshold for fuzzy matching in pass 2. 0.7 means at least 70%
 *  of the union of tokens must overlap. With Jaccard this is strict — most
 *  legitimate same-job pairs differ only in casing or stopwords. Lower this
 *  cautiously, false positives compound quickly. */
const FUZZY_THRESHOLD = 0.7;

/** Minimum tokens (post-stopword filter) on each side before a pair is
 *  eligible for fuzzy matching. Short generic titles ("Engineer", "Manager",
 *  "Analyst") have too few discriminators — at 1-2 tokens, Jaccard fires
 *  trivially. Below this threshold, only Pass 1 exact-match can merge. */
const FUZZY_MIN_TOKENS = 3;

/** Description-similarity thresholds. Used as a second signal so that e.g.
 *  three legitimately different "Senior/Product Manager" roles at the same
 *  employer don't collapse into one record just because their titles tied.
 *  Only enforced when BOTH descriptions have enough meaningful tokens —
 *  otherwise fall back to title+date alone (SEEK teasers vs MCF full JDs
 *  shouldn't be punished for length mismatch). */
const DESC_MIN_TOKENS = 30;
const DESC_CONTAINMENT_THRESHOLD = 0.4;
const DESC_MIN_SHARED = 8;

/** True only when each title token-set has at least one token the other
 *  doesn't. Prevents the subset trap: "Software Engineer" vs "Software
 *  Engineer (Linux)" — Jaccard alone scores 0.8 and merges; but the right
 *  side has the "linux" discriminator and the left side has nothing extra,
 *  so this returns false and we skip the merge. Same logic kills "X" vs
 *  "Senior X", "X" vs "Staff X", "X" vs "X (Specialization)", etc. */
function hasMutualUniqueTokens(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  let aHasUnique = false;
  for (const t of setA) {
    if (!setB.has(t)) {
      aHasUnique = true;
      break;
    }
  }
  if (!aHasUnique) return false;
  for (const t of setB) if (!setA.has(t)) return true;
  return false;
}

/** Returns true when descriptions agree closely enough to confirm a merge,
 *  OR when at least one side is too thin to apply the test. The latter keeps
 *  cross-source teaser-vs-fullJD pairs working — title+date already gates
 *  those tightly. */
function descriptionsAgree(
  a: Set<string>,
  b: Set<string>,
): boolean {
  if (a.size < DESC_MIN_TOKENS || b.size < DESC_MIN_TOKENS) return true;
  const { containment, shared } = descriptionContainment(a, b);
  return shared >= DESC_MIN_SHARED && containment >= DESC_CONTAINMENT_THRESHOLD;
}

export interface DedupeStats {
  /** Count of jobs that were merged INTO another record (so output -
   *  input count would be -dupes if we didn't drop them). */
  dupes: number;
  /** Per-source-combination overlap counts. Useful for sanity-checking that
   *  dedup is doing what we expect across runs. */
  merges: {
    mcfAndSeek: number;
    mcfAndGovtech: number;
    seekAndGovtech: number;
    allThree: number;
  };
}

/** A single merge event — the canonical record we kept, plus the records that
 *  got folded into it. Emitted so the scraper can write a human-readable
 *  report file for manual audit (catch false-positive merges). */
export interface MergeRecord {
  pass: "exact" | "fuzzy";
  kept: { id: string; source: string; title: string; company: string; url: string };
  merged: Array<{ id: string; source: string; title: string; company: string; url: string }>;
}

export interface DedupeResult {
  unique: Job[];
  stats: DedupeStats;
  /** Detailed merge log, one entry per merge event. Empty for runs with no
   *  cross-source overlap. */
  mergeLog: MergeRecord[];
}

function jobRef(j: Job): MergeRecord["kept"] {
  return {
    id: j.id,
    source: j.source,
    title: j.title,
    company: j.company.name,
    url: j.url,
  };
}

function pickWinner(jobs: Job[]): Job {
  let best = jobs[0]!;
  for (const j of jobs.slice(1)) {
    if (SOURCE_PRIORITY[j.source] > SOURCE_PRIORITY[best.source]) best = j;
  }
  return best;
}

function merge(group: Job[]): Job {
  const winner: Job = { ...pickWinner(group) };
  const losers = group.filter((j) => j !== winner);

  // Backfill: fields the winner is missing but a loser has filled in.
  for (const l of losers) {
    if (!winner.salary && l.salary) winner.salary = l.salary;
    if (!winner.location && l.location) winner.location = l.location;
    if (!winner.expiryDate && l.expiryDate) winner.expiryDate = l.expiryDate;
    if (!winner.postedDate && l.postedDate) winner.postedDate = l.postedDate;
    if (winner.applicantCount == null && l.applicantCount != null) {
      winner.applicantCount = l.applicantCount;
    }
    // Prefer richer description if winner's is shorter (SEEK winners
    // basically never happen but if MCF and GovTech both have descriptions,
    // GovTech wins by priority — keep its content unless it's a stub).
    const wLen = (winner.descriptionText ?? winner.description ?? "").length;
    const lLen = (l.descriptionText ?? l.description ?? "").length;
    if (lLen > wLen * 1.5) {
      winner.description = l.description;
      winner.descriptionText = l.descriptionText ?? winner.descriptionText;
    }
  }

  // Union of array facets — losing sources may have caught categories or
  // skills the winning source missed.
  winner.employmentTypes = Array.from(
    new Set([...winner.employmentTypes, ...losers.flatMap((l) => l.employmentTypes)]),
  );
  winner.seniority = Array.from(
    new Set([...winner.seniority, ...losers.flatMap((l) => l.seniority)]),
  );
  winner.categories = Array.from(
    new Set([...winner.categories, ...losers.flatMap((l) => l.categories)]),
  );
  winner.skills = Array.from(
    new Set([...winner.skills, ...losers.flatMap((l) => l.skills)]),
  );

  // Stash loser links so the UI can render "Also on JobStreet" chips.
  winner.alsoOn = losers.map((l) => ({
    source: l.source,
    sourceId: l.sourceId,
    url: l.url,
  }));

  return winner;
}

function trackMerge(group: Job[], stats: DedupeStats): void {
  const srcs = new Set(group.map((j) => j.source));
  if (srcs.size < 2) return; // single-source repost — not cross-source noise
  if (srcs.has("mcf") && srcs.has("seek") && srcs.has("govtech")) {
    stats.merges.allThree++;
    return;
  }
  if (srcs.has("mcf") && srcs.has("seek")) stats.merges.mcfAndSeek++;
  if (srcs.has("mcf") && srcs.has("govtech")) stats.merges.mcfAndGovtech++;
  if (srcs.has("seek") && srcs.has("govtech")) stats.merges.seekAndGovtech++;
}

export function dedupeJobs(jobs: Job[]): DedupeResult {
  const stats: DedupeStats = {
    dupes: 0,
    merges: { mcfAndSeek: 0, mcfAndGovtech: 0, seekAndGovtech: 0, allThree: 0 },
  };
  const mergeLog: MergeRecord[] = [];

  function recordMerge(group: Job[], pass: MergeRecord["pass"]): void {
    const winner = pickWinner(group);
    const losers = group.filter((j) => j !== winner);
    mergeLog.push({
      pass,
      kept: jobRef(winner),
      merged: losers.map(jobRef),
    });
  }

  // Precompute description fingerprints once per job — both passes consult
  // them via descriptionsAgree() below.
  const fp = new Map<Job, Set<string>>();
  for (const j of jobs) {
    fp.set(j, descriptionFingerprint(j.description, j.descriptionText));
  }

  // Bucket by canonical company. Different companies = different jobs, full stop.
  const byCompany = new Map<string, Job[]>();
  for (const j of jobs) {
    const key = canonicalCompany(j.company.name);
    const arr = byCompany.get(key) ?? [];
    arr.push(j);
    byCompany.set(key, arr);
  }

  const output: Job[] = [];

  for (const bucket of byCompany.values()) {
    // ---- Pass 1: exact title-key + posted-date proximity ----
    const byTitleKey = new Map<string, Job[]>();
    for (const j of bucket) {
      const tk = normalizeTitleForMatch(j.title);
      const arr = byTitleKey.get(tk) ?? [];
      arr.push(j);
      byTitleKey.set(tk, arr);
    }

    const stillSingle: Job[] = [];
    for (const sameTitleGroup of byTitleKey.values()) {
      if (sameTitleGroup.length === 1) {
        stillSingle.push(sameTitleGroup[0]!);
        continue;
      }
      // Split the title-group further by posted-date proximity AND
      // description agreement. Anything outside MERGE_WINDOW_DAYS, or whose
      // description fingerprint doesn't match an existing member, forms its
      // own cluster (likely a different role with a same-shaped title rather
      // than a cross-source duplicate).
      const clusters: Job[][] = [];
      for (const j of sameTitleGroup) {
        const jf = fp.get(j)!;
        const home = clusters.find((c) =>
          c.some(
            (other) =>
              daysBetween(j.postedDate, other.postedDate) <= MERGE_WINDOW_DAYS
              && descriptionsAgree(jf, fp.get(other)!),
          ),
        );
        if (home) home.push(j);
        else clusters.push([j]);
      }
      for (const c of clusters) {
        if (c.length === 1) {
          stillSingle.push(c[0]!);
        } else {
          const merged = merge(c);
          stats.dupes += c.length - 1;
          trackMerge(c, stats);
          recordMerge(c, "exact");
          output.push(merged);
        }
      }
    }

    // ---- Pass 2: fuzzy Jaccard overlap on remaining singletons ----
    // Greedy: walk the list once, for each job try to find an earlier-emitted
    // cluster it fits into. We compare ONLY against the seed (first member)
    // tokens — NOT a growing union — so clusters can't drift token-by-token.
    // O(n^2) per bucket, but buckets are small (10s of jobs per company).
    const fuzzyClusters: Array<{ seedTokens: string[]; jobs: Job[] }> = [];
    for (const j of stillSingle) {
      const toks = titleTokens(j.title);
      let placed = false;
      // Too few tokens — can't risk fuzzy matching; only Pass 1 can collapse these.
      if (toks.length < FUZZY_MIN_TOKENS) {
        fuzzyClusters.push({ seedTokens: toks, jobs: [j] });
        continue;
      }
      const jf = fp.get(j)!;
      for (const cluster of fuzzyClusters) {
        if (cluster.seedTokens.length < FUZZY_MIN_TOKENS) continue;
        // Reject strict subset/superset pairs — adding one qualifier token to
        // a base title (e.g. "X" → "X (Linux)") almost always means a
        // specialization, not a duplicate. Without this gate Jaccard hands
        // back 0.75-0.85 for these pairs and they wrongly merge.
        if (!hasMutualUniqueTokens(toks, cluster.seedTokens)) continue;
        if (tokenOverlap(toks, cluster.seedTokens) < FUZZY_THRESHOLD) continue;
        if (
          !cluster.jobs.some(
            (other) =>
              daysBetween(j.postedDate, other.postedDate) <= MERGE_WINDOW_DAYS
              && descriptionsAgree(jf, fp.get(other)!),
          )
        ) {
          continue;
        }
        cluster.jobs.push(j);
        placed = true;
        break;
      }
      if (!placed) fuzzyClusters.push({ seedTokens: toks, jobs: [j] });
    }

    for (const c of fuzzyClusters) {
      if (c.jobs.length === 1) {
        output.push(c.jobs[0]!);
      } else {
        const merged = merge(c.jobs);
        stats.dupes += c.jobs.length - 1;
        trackMerge(c.jobs, stats);
        recordMerge(c.jobs, "fuzzy");
        output.push(merged);
      }
    }
  }

  return { unique: output, stats, mergeLog };
}
