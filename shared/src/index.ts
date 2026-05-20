// Shared types used by both /client and /server.
// Single source of truth — never duplicate these on either side.

// -------------------- Jobs --------------------

export type EmploymentType =
  | "Full Time"
  | "Part Time"
  | "Contract"
  | "Permanent"
  | "Temporary"
  | "Internship"
  | "Flexi-work"
  | "Freelance";

export type SeniorityLevel =
  | "Fresh/entry level"
  | "Junior Executive"
  | "Executive"
  | "Senior Executive"
  | "Manager"
  | "Senior Management"
  | "Professional"
  | "Non-executive";

export type JobSource = "mcf" | "seek" | "govtech" | "linkedin" | "indeed";

/** Normalized job, source-agnostic. Adding new sources = new adapter, not new fields. */
export interface Job {
  /** Composite id: `${source}:${sourceId}` */
  id: string;
  source: JobSource;
  sourceId: string;
  /** Deep link back to the original posting on the source site */
  url: string;

  title: string;
  company: {
    name: string;
    uen?: string;
    logoUrl?: string;
  };
  description: string;
  /** Optional plain-text variant if the source provides HTML in `description` */
  descriptionText?: string;

  location?: string;
  employmentTypes: EmploymentType[];
  seniority: SeniorityLevel[];
  categories: string[];
  skills: string[];

  salary?: {
    min?: number;
    max?: number;
    currency?: string;
    period?: "monthly" | "annual" | "hourly" | "daily";
  };

  postedDate?: string; // ISO
  expiryDate?: string; // ISO

  /** Number of applicants the source reports (currently only SEEK exposes this).
   *  Surfaced in the UI as social proof: "23 applicants so far". */
  applicantCount?: number;

  /** When a job appears on multiple boards, the canonical record keeps deep
   *  links to every source it was deduped against. The UI renders these as
   *  "Also on JobStreet, MyCareersFuture" chips. */
  alsoOn?: Array<{
    source: JobSource;
    sourceId: string;
    url: string;
  }>;

  /** Raw source payload for debugging / fields we haven't normalized yet */
  raw?: unknown;
}

/** Presets, not arbitrary dates — matches the MCF UI's freshness buckets. */
export type PostedWithin = "1d" | "3d" | "7d" | "14d" | "30d";

export const POSTED_WITHIN_DAYS: Record<PostedWithin, number> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export const POSTED_WITHIN_LABELS: Record<PostedWithin, string> = {
  "1d": "Last 24h",
  "3d": "Last 3 days",
  "7d": "Last week",
  "14d": "Last 2 weeks",
  "30d": "Last month",
};

export interface JobSearchFilters {
  employmentType?: EmploymentType[];
  seniority?: SeniorityLevel[];
  salaryMin?: number;
  salaryMax?: number;
  category?: string[];
  postedWithin?: PostedWithin;
}

export interface JobSearchRequest {
  query?: string;
  page?: number;
  limit?: number;
  filters?: JobSearchFilters;
}

export interface JobSearchResponse {
  /** Filtered jobs for this visible page. Always up to `limit` items unless
   *  the upstream has been exhausted. */
  results: Job[];
  /** Raw upstream total (before local filters). Useful as a context number
   *  ("scanning N jobs") but not a page-count source of truth. */
  total: number;
  /** Number of filtered jobs the server has seen so far while paginating to
   *  satisfy this request. Lower-bound on the true filtered total. */
  knownCount: number;
  /** True if upstream has been fully scanned — `knownCount` is then exact. */
  exhausted: boolean;
  /** True when there could be more filtered jobs beyond this page (either
   *  more upstream to scan, or already-scanned items past the current slice). */
  hasMore: boolean;
  /** Number of upstream pages the server fetched to produce this response.
   *  Surfaced so the UI can be honest about heavy filtering. */
  upstreamPagesFetched: number;
  page: number;
  limit: number;
}

// -------------------- Resume --------------------

export interface ResumeContact {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  links: string[];
}

export interface ResumeExperience {
  title: string;
  company: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  current: boolean;
  bullets: string[];
}

export interface ResumeEducation {
  degree: string;
  institution: string;
  startDate?: string;
  endDate?: string;
  gpa?: string;
}

export interface ResumeSkills {
  technical: string[];
  soft: string[];
  languages: string[];
  tools: string[];
}

export interface ResumeProject {
  name: string;
  description: string;
  technologies: string[];
  link?: string;
}

export interface Resume {
  contact: ResumeContact;
  summary: string;
  experiences: ResumeExperience[];
  education: ResumeEducation[];
  skills: ResumeSkills;
  projects: ResumeProject[];
  certifications: string[];
}

// -------------------- AI features (forward declarations for Phase 2) --------------------

export type GapCategory =
  | "industry"
  | "skills"
  | "seniority"
  | "experience"
  | "location"
  | "none";

export interface MatchScore {
  score: number; // 0-100
  gap_category?: GapCategory;
  strengths: string[];
  gaps: string[];
  hidden_strengths: string[];
  suggestions: string[];
}

export type CoverLetterTone = "formal" | "conversational" | "enthusiastic";

export type GenerationMode = "default" | "transition";

export const GAP_CATEGORY_LABEL: Record<GapCategory, string> = {
  industry: "Different industry",
  skills: "Skills gap",
  seniority: "Seniority mismatch",
  experience: "Experience level",
  location: "Location",
  none: "Strong overall fit",
};

// -------------------- Batch matching --------------------

/** Lightweight match score returned by the /match-batch endpoint. Trades
 *  the full per-job strengths/gaps/suggestions for a compact form suitable
 *  for ranking the entire visible list in one Haiku call. */
export interface MatchScoreLite {
  jobId: string;
  score: number; // 0-100
  rationale: string; // one-sentence reason
}

export interface MatchBatchRequest {
  /** Subset of jobs to score. Only fields used by the prompt are required;
   *  client passes the full Job to keep the call self-contained. */
  jobs: Job[];
  resume: Resume;
  /** Fingerprint of the resume content; server echoes it back so the client
   *  can validate the cache key on receipt (cheap belt-and-braces). */
  resumeHash: string;
}

export interface MatchBatchResponse {
  resumeHash: string;
  scores: MatchScoreLite[];
}

// -------------------- Interview prep --------------------

export interface InterviewQuestion {
  question: string;
  /** Why this question is likely — pull from JD specifics, gaps in resume,
   *  career changes, etc. */
  why: string;
  /** STAR-method draft answer assembled from real resume bullets. May be
   *  empty when the candidate has no relevant experience to anchor it. */
  star: {
    situation: string;
    task: string;
    action: string;
    result: string;
  } | null;
  /** Tags: "behavioral" | "technical" | "culture-fit" | "experience". */
  tags: string[];
}

export interface InterviewRedFlag {
  /** Concern an interviewer is likely to raise. */
  concern: string;
  /** How to address it honestly. No fabrication. */
  suggested_response: string;
}

export interface InterviewPrep {
  questions: InterviewQuestion[];
  red_flags: InterviewRedFlag[];
  /** Topics worth brushing up on before the interview. */
  prep_topics: string[];
}
