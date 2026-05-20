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

/** Normalize a job title for fuzzy matching. Strips reference codes,
 *  seniority abbreviations, and collapses whitespace. Parenthetical and
 *  bracket CONTENTS are preserved — they almost always carry the
 *  role-discriminator ("(Backend)", "(Java)", "(Senior)") and stripping them
 *  collapses genuinely different roles into one match key. Only the
 *  delimiters are removed so the content tokenizes normally.
 *  Returns a lowercased token-friendly string — NOT for display. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    // Ref codes are pure noise — kill them before bracket content is freed.
    .replace(/\b(job\s*id|ref(?:erence)?)\s*[:#]?\s*\w+/gi, " ")
    .replace(/[()\[\]]/g, " ")
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

/** Symmetric Jaccard token overlap: |A ∩ B| / |A ∪ B|. Bounded 0..1.
 *  Previously this divided by min(|A|,|B|), which returned 1.0 for any subset
 *  pair — so "Software Engineer" matched "Senior Software Engineer",
 *  "Software Engineer Lead", "Junior Software Engineer" all at 1.0 and merged
 *  them indiscriminately. Jaccard penalizes the discriminator tokens that
 *  appear on only one side, which is exactly the signal we want. */
export function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
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

/** Extra stopwords for description fingerprinting. Job descriptions are full
 *  of boilerplate ("we are looking for", "you will be responsible for") that
 *  is shared across genuinely different postings and would inflate similarity.
 *  Keeping this list tight — words common enough that their presence carries
 *  no signal but rare enough that pruning them doesn't gut the fingerprint. */
const DESC_BOILERPLATE = new Set([
  "we", "our", "you", "your", "us", "this", "that", "these", "those",
  "is", "are", "be", "been", "being", "was", "were",
  "have", "has", "had", "will", "would", "should", "could", "may", "might", "must", "can",
  "do", "does", "did", "done",
  "as", "if", "but", "not", "no", "yes", "all", "any", "some", "such",
  "work", "team", "role", "job", "position", "candidate", "applicant", "applicants",
  "company", "employer", "employee", "employees", "join", "joining",
  "looking", "seeking", "based", "include", "includes", "including",
  "ability", "able", "experience", "experienced", "knowledge", "skills",
  "responsibility", "responsibilities", "responsible", "duties",
  "requirement", "requirements", "required", "must-have",
  "preferred", "desirable", "nice-to-have",
  "year", "years", "minimum", "least",
  "good", "strong", "excellent", "proven", "demonstrated", "solid",
  "across", "within", "into", "onto", "upon",
  "etc", "eg", "ie", "more", "also", "well", "very", "highly",
  "new", "fast", "high", "low",
]);

/** Build a per-job description fingerprint — a Set of meaningful tokens with
 *  boilerplate and short/numeric noise removed. Used by the dedupe pass as a
 *  second signal beyond title+date. Prefer the plain-text variant when
 *  available; otherwise the HTML version after a coarse tag strip. */
export function descriptionFingerprint(
  description: string | undefined,
  descriptionText: string | undefined,
): Set<string> {
  const raw = descriptionText ?? description ?? "";
  if (!raw) return new Set();
  const out = new Set<string>();
  // Strip tags + entities just in case caller passed raw HTML
  const cleaned = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .toLowerCase();
  for (const tok of cleaned.split(/[^a-z0-9+#.]+/)) {
    if (tok.length < 3) continue;
    if (/^\d+$/.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    if (DESC_BOILERPLATE.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Asymmetric containment: |A ∩ B| / min(|A|, |B|). Picked over Jaccard
 *  because cross-source descriptions vary wildly in length (SEEK ships a
 *  ~50-word teaser, MCF a ~400-word JD). Jaccard penalizes that mismatch
 *  even when the shorter side is fully embedded in the longer; containment
 *  doesn't. We guard against the "tiny stub matches everything" failure
 *  mode separately by requiring a minimum shared-token count at the call site. */
export function descriptionContainment(
  a: Set<string>,
  b: Set<string>,
): { containment: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { containment: 0, shared: 0 };
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of smaller) if (larger.has(t)) shared++;
  return { containment: shared / smaller.size, shared };
}
