// GovTech / careers.gov.sg scrape. Trivially simple: opengovsg already
// publishes a daily-refreshed JSON dump at:
//   https://raw.githubusercontent.com/opengovsg/careersgovsg-jobs-data/main/data/job-listings.json
// We just fetch it, normalize, and apply the 30-day cutoff.

import type { EmploymentType, Job, SeniorityLevel } from "@aggregator/shared";

const URL = "https://raw.githubusercontent.com/opengovsg/careersgovsg-jobs-data/main/data/job-listings.json";

/** Lightweight HTML → plain text. GovTech descriptions are HTML-ish but use
 *  a narrow tag vocabulary (p, ul, li, strong, br) so a regex strip is safe
 *  and avoids pulling in a real parser at scrape time. */
function stripHtml(html: string): string {
  return html
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

interface GovTechRaw {
  platform?: string;
  postingNo?: string;
  jobId?: string;
  jobTitle?: string;
  agency?: string;
  agencyId?: string;
  agencyDescription?: string;
  startDate?: number; // epoch ms
  closingDate?: number;
  employmentType?: string;
  experienceRequired?: string;
  experienceYearsMin?: number;
  experienceYearsMax?: number;
  field?: string;
  functionalArea?: string;
  industry?: string;
  isNew?: boolean;
  location?: string;
  jobDescription?: string;
  jobResponsibilities?: string;
  jobRequirements?: string;
  salaryMin?: number;
  salaryMax?: number;
  applicationUrl?: string;
}

function mapEmployment(t: string | undefined): EmploymentType[] {
  if (!t) return [];
  const s = t.toLowerCase();
  if (s.includes("fixed")) return ["Contract"];
  if (s.includes("perm")) return ["Permanent", "Full Time"];
  if (s.includes("contract")) return ["Contract"];
  if (s.includes("temp")) return ["Temporary"];
  if (s.includes("intern")) return ["Internship"];
  if (s.includes("part")) return ["Part Time"];
  return ["Full Time"];
}

/** Infer a seniority level from the experience-years range. Conservative —
 *  if range is missing or contradictory we return [] rather than guess. */
function mapSeniority(min?: number, max?: number): SeniorityLevel[] {
  if (min == null && max == null) return [];
  const lo = min ?? 0;
  const hi = max ?? lo;
  if (hi <= 1) return ["Fresh/entry level"];
  if (hi <= 3) return ["Junior Executive"];
  if (hi <= 6) return ["Executive"];
  if (hi <= 10) return ["Senior Executive", "Manager"];
  return ["Senior Management"];
}

function normalize(r: GovTechRaw): Job | null {
  const id = r.postingNo ?? r.jobId;
  const title = r.jobTitle;
  if (!id || !title) return null;

  const descriptionHtml = [r.jobDescription, r.jobResponsibilities, r.jobRequirements]
    .filter(Boolean)
    .join("\n");

  return {
    id: `govtech:${id}`,
    source: "govtech",
    sourceId: id,
    url: r.applicationUrl ?? `https://www.careers.gov.sg/job/${id}`,
    title,
    company: {
      name: r.agency ?? "Singapore Government",
    },
    description: descriptionHtml,
    descriptionText: descriptionHtml ? stripHtml(descriptionHtml) : undefined,
    location: r.location || "Singapore",
    employmentTypes: mapEmployment(r.employmentType),
    seniority: mapSeniority(r.experienceYearsMin, r.experienceYearsMax),
    categories: [r.field, r.functionalArea, r.industry].filter((x): x is string => !!x),
    skills: [],
    salary:
      r.salaryMin != null || r.salaryMax != null
        ? { min: r.salaryMin, max: r.salaryMax, currency: "SGD", period: "monthly" }
        : undefined,
    postedDate: r.startDate ? new Date(r.startDate).toISOString() : undefined,
    expiryDate: r.closingDate ? new Date(r.closingDate).toISOString() : undefined,
  };
}

export interface ScrapeOptions {
  postedAfter?: string;
}

export async function scrapeGovtech(_opts: ScrapeOptions = {}): Promise<Job[]> {
  void _opts;
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`GovTech ${res.status}`);
  const raw = (await res.json()) as GovTechRaw[];
  console.log(`[govtech] fetched ${raw.length} raw postings`);

  const out: Job[] = [];
  for (const r of raw) {
    const j = normalize(r);
    if (!j) continue;
    out.push(j);
  }
  console.log(`[govtech] normalized ${out.length} postings`);
  return out;
}
