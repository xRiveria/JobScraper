// MyCareersFuture adapter. Source for v1.
//
// Verified from a real captured XHR (May 2026):
//   POST https://api.mycareersfuture.gov.sg/v2/search?limit=N&page=N
//   Headers: content-type: application/json
//            mcf-client: jobseeker       <- gating header
//            origin/referer: https://www.mycareersfuture.gov.sg
//   Body (minimal):  {"sessionId":"<ga-id>.<ts>","postingCompany":[]}
//   No auth header, no cookie, credentials: "omit".
//
// Filter strategy: we send the user's free-text `search` to MCF but apply
// employment-type / seniority / salary / posted-date filters locally on the
// normalized Job[] in /api/jobs/search. This keeps the aggregator
// source-agnostic — adding LinkedIn / Indeed adapters needs no filter
// changes — and avoids guessing at upstream filter schemas we haven't
// observed in a real capture.

import type {
  EmploymentType,
  Job,
  JobSearchRequest,
  SeniorityLevel,
} from "@aggregator/shared";

/** Internal — one upstream page worth of results. The aggregator route in
 *  routes/jobs.ts wraps multiple of these into the public JobSearchResponse. */
export interface McfSearchPage {
  results: Job[];
  /** Raw upstream total (before any local filtering). */
  total: number;
  page: number;
  limit: number;
}

const MCF_BASE = "https://api.mycareersfuture.gov.sg/v2/search";
const MCF_JOB_BASE = "https://api.mycareersfuture.gov.sg/v2/jobs";

const MCF_HEADERS: HeadersInit = {
  "content-type": "application/json",
  accept: "*/*",
  "mcf-client": "jobseeker",
  origin: "https://www.mycareersfuture.gov.sg",
  referer: "https://www.mycareersfuture.gov.sg/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};

/** Generate a sessionId mirroring the GA-style `<clientId>.<timestamp>` MCF expects. */
function generateSessionId(): string {
  const clientId = Math.floor(Math.random() * 1e10).toString();
  const ts = Date.now().toString().slice(0, 10);
  return `${clientId}.${ts}`;
}

interface McfBody {
  sessionId: string;
  postingCompany: string[];
  search?: string;
  /** Verified from a captured XHR (May 2026) when "Information Technology"
   *  was selected in the sidebar:
   *    { sessionId, categories: ["Information Technology"], postingCompany: [] }
   *  Array of category-name strings; MCF AND-matches against job.categories. */
  categories?: string[];
}

function buildMcfBody(req: JobSearchRequest): McfBody {
  const body: McfBody = {
    sessionId: generateSessionId(),
    postingCompany: [],
  };
  if (req.query && req.query.trim()) body.search = req.query.trim();
  if (req.filters?.category?.length) body.categories = req.filters.category;
  return body;
}

/** Raw MCF result shape (subset — extra fields tolerated). */
interface McfResult {
  uuid?: string;
  metadata?: {
    jobPostId?: string;
    newPostingDate?: string;
    expiryDate?: string;
    [k: string]: unknown;
  };
  title?: string;
  description?: string;
  postedCompany?: { name?: string; uen?: string; logoUploadPath?: string };
  hiringCompany?: { name?: string; uen?: string; logoUploadPath?: string };
  salary?: { minimum?: number; maximum?: number; type?: { salaryType?: string } };
  employmentTypes?: Array<{ employmentType?: string }>;
  positionLevels?: Array<{ position?: string }>;
  categories?: Array<{ category?: string }>;
  skills?: Array<{ skill?: string }>;
  [k: string]: unknown;
}

interface McfResponse {
  results?: McfResult[];
  total?: number;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalize(r: McfResult): Job | null {
  const sourceId = r.uuid ?? r.metadata?.jobPostId;
  const title = r.title;
  if (!sourceId || !title) return null;

  const company = r.hiringCompany?.name
    ? r.hiringCompany
    : (r.postedCompany ?? { name: "Unknown" });
  const descriptionHtml = r.description ?? "";

  return {
    id: `mcf:${sourceId}`,
    source: "mcf",
    sourceId,
    url: `https://www.mycareersfuture.gov.sg/job/${sourceId}`,
    title,
    company: {
      name: company.name ?? "Unknown",
      uen: company.uen,
      logoUrl: company.logoUploadPath,
    },
    description: descriptionHtml,
    descriptionText: descriptionHtml ? stripHtml(descriptionHtml) : undefined,
    employmentTypes: (r.employmentTypes ?? [])
      .map((e) => e.employmentType)
      .filter((x): x is string => !!x) as EmploymentType[],
    seniority: (r.positionLevels ?? [])
      .map((p) => p.position)
      .filter((x): x is string => !!x) as SeniorityLevel[],
    categories: (r.categories ?? [])
      .map((c) => c.category)
      .filter((x): x is string => !!x),
    skills: (r.skills ?? []).map((s) => s.skill).filter((x): x is string => !!x),
    salary:
      r.salary?.minimum != null || r.salary?.maximum != null
        ? {
            min: r.salary.minimum,
            max: r.salary.maximum,
            currency: "SGD",
            period: "monthly",
          }
        : undefined,
    postedDate: r.metadata?.newPostingDate,
    expiryDate: r.metadata?.expiryDate,
  };
}

/** Fetch full details for a single job by uuid. MCF exposes this at:
 *    GET https://api.mycareersfuture.gov.sg/v2/jobs/<uuid>
 *  Same auth model as search (no auth, but `mcf-client` header required).
 *  The response shape is a superset of the search result item, with the full
 *  HTML description in `description`. */
export async function mcfGetJob(uuid: string): Promise<Job | null> {
  const res = await fetch(`${MCF_JOB_BASE}/${encodeURIComponent(uuid)}`, {
    method: "GET",
    headers: MCF_HEADERS,
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCF ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = (await res.json()) as McfResult;
  const job = normalize(raw);
  if (!job) return null;
  // Stash the raw payload for debugging / future field extraction.
  job.raw = raw;
  return job;
}

export interface McfSearchResult {
  normalized: McfSearchPage;
  raw: McfResponse;
}

export async function mcfSearch(req: JobSearchRequest): Promise<McfSearchResult> {
  const page = req.page ?? 0;
  const limit = Math.min(req.limit ?? 20, 100);
  const url = `${MCF_BASE}?limit=${limit}&page=${page}`;

  const res = await fetch(url, {
    method: "POST",
    headers: MCF_HEADERS,
    body: JSON.stringify(buildMcfBody(req)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCF ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = (await res.json()) as McfResponse;
  const results = (raw.results ?? [])
    .map(normalize)
    .filter((j): j is Job => j !== null);

  return {
    normalized: {
      results,
      total: raw.total ?? results.length,
      page,
      limit,
    },
    raw,
  };
}
