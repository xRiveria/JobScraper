// Shared normalization helpers used by the dedup pass. None of these mutate
// the original Job — they produce *matching keys* that get the same value
// for records we want to collapse. Display values stay untouched.
//
// Design rules:
//  - Deterministic (no LLM, no network, no randomness)
//  - Conservative: when in doubt, return the input verbatim rather than
//    overreach and accidentally merge two genuinely different jobs.

/** Strip company-suffix noise so "DBS Bank Ltd" and "DBS Bank Limited" and
 *  "DBS Bank Pte. Ltd." all collapse to "dbs bank". Known aliases get
 *  rewritten to a canonical form. Used as the bucketing key in dedup. */
export function canonicalCompany(name: string): string {
  let s = name.toLowerCase().trim();

  // Strip legal-form suffixes — order matters, longer ones first to avoid
  // "ltd" matching before "private limited".
  const suffixes = [
    /\bprivate\s+limited\b/g,
    /\bpte\.?\s*ltd\.?/g,
    /\bllp\b/g,
    /\bllc\b/g,
    /\binc\.?\b/g,
    /\bcorp\.?\b/g,
    /\bcorporation\b/g,
    /\blimited\b/g,
    /\bltd\.?\b/g,
    /\bgroup\b/g,
    /\bholdings?\b/g,
    /\bsingapore\b/g, // "Foo Singapore" is usually the SG subsidiary of "Foo"
    /\(.*?\)/g, // any trailing "(Asia)" / "(SG)" qualifiers
    /[,.]/g, // strip stray punctuation
  ];
  for (const r of suffixes) s = s.replace(r, " ");
  s = s.replace(/\s+/g, " ").trim();

  // Known aliases. Keep this list small — broad aliasing creates false
  // positive merges. Add an entry only when we observe real duplication.
  const aliases: Record<string, string> = {
    "government technology agency": "govtech",
    "government technology agency of singapore": "govtech",
    "dbs": "dbs bank",
    "dbs group": "dbs bank",
    "dbs bank": "dbs bank",
  };
  return aliases[s] ?? s;
}

/** Normalize a job title for fuzzy matching. Strips parenthetical qualifiers,
 *  reference codes, seniority abbreviations, and collapses whitespace.
 *  Returns a lowercased token-friendly string — NOT for display. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // "(Full Stack)" → ""
    .replace(/\[.*?\]/g, " ") // "[REF: 12345]" → ""
    .replace(/\b(job\s*id|ref(?:erence)?)\s*[:#]?\s*\w+/gi, " ")
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bsnr\b/g, "senior")
    .replace(/\bjr\.?\b/g, "junior")
    .replace(/\bjnr\b/g, "junior")
    .replace(/[\/\-_,]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tiny stopword list — only words frequent enough that their presence/absence
// shouldn't influence match decisions. Don't expand without evidence.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at",
  "with", "by", "from",
]);

/** Tokens for overlap scoring. Drops single-character tokens and stopwords. */
export function titleTokens(title: string): string[] {
  return normalizeTitleForMatch(title)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Symmetric token-overlap ratio: |A ∩ B| / min(|A|, |B|).
 *  Bounded 0..1. Returns 1 when one set is a subset of the other — that's the
 *  exact case we want to catch ("Software Engineer" ⊂ "Software Engineer (Backend)"). */
export function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits++;
  return hits / Math.min(a.length, b.length);
}

/** Days between two ISO date strings. Returns Infinity when either is missing
 *  so callers using "within N days" guards never merge dateless pairs. */
export function daysBetween(a?: string, b?: string): number {
  if (!a || !b) return Infinity;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(ta - tb) / 86_400_000;
}
