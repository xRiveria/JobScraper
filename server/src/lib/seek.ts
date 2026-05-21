// SEEK / JobStreet adapter. Captured XHR from sg.jobstreet.com (May 2026):
//
//   POST https://{host}/graphql
//   operationName: "JobSearchV6"
//   Headers: content-type: application/json
//            seek-request-brand: jobstreet | seek | jobsdb
//            seek-request-country: SG | AU | NZ | HK | MY | PH | ID | TH
//            x-seek-site: chalice
//            x-seek-ec-sessionid: <uuid>     <- self-referential analytics
//            x-seek-ec-visitorid: <uuid>     <- we forge these per request
//
//   Body params (relevant subset):
//     siteKey, locale, source: "FE_SERP", channel: "web",
//     page (1-indexed), pageSize (cap ~32),
//     solId, userQueryId, userSessionId,
//     eventCaptureSessionId, eventCaptureUserId,
//     keywords?, where?, classification?, subclassification?,
//     worktype?, salaryrange?, salarytype?, daterange?, sortmode?
//
// Cookies are NOT required — the session-IDs in cookies just mirror header
// values. Same trick as MCF's GA-style sessionId.
//
// One adapter covers 8 markets (SG/AU/NZ/HK/MY/PH/ID/TH) by varying brand +
// country + host. For Phase 1 we wire SG only.

import { randomUUID } from "node:crypto";
import type {
  EmploymentType,
  Job,
  JobSearchRequest,
  SeniorityLevel,
} from "@aggregator/shared";

export interface SeekSearchPage {
  results: Job[];
  total: number;
  page: number;
  limit: number;
}

export interface SeekSearchResult {
  normalized: SeekSearchPage;
  raw: unknown;
}

const SEEK_HOST = "https://sg.jobstreet.com";
const SEEK_GRAPHQL = `${SEEK_HOST}/graphql`;

/** JobSearchV6 query. Pasted verbatim from a real SEEK SPA cURL capture —
 *  SEEK's gateway hashes incoming queries and rejects unknown shapes with
 *  a generic UNSTABLE_QUERY_ERROR even when the query is semantically valid.
 *  Only the exact selection set from the SPA's real request hashes to an
 *  accepted signature. Do NOT trim this — even removing one __typename can
 *  re-trigger the error.
 *
 *  We still parse only what we need via the narrow SeekRawJob interface
 *  below; extra bytes ride along on the response but never enter our Job objects. */
const JOB_SEARCH_QUERY = `query JobSearchV6($params: JobSearchV6QueryInput!, $locale: Locale!, $timezone: Timezone!) {
  jobSearchV6(params: $params) {
    canonicalCompany {
      description
      __typename
    }
    data {
      advertiser {
        id
        description
        __typename
      }
      branding {
        serpLogoUrl
        __typename
      }
      bulletPoints
      classifications {
        classification {
          id
          description
          __typename
        }
        subclassification {
          id
          description
          __typename
        }
        __typename
      }
      companyName
      companyProfileStructuredDataId
      currencyLabel
      displayType
      employer {
        companyUrl
        __typename
      }
      externalReferences {
        id
        sourceSystem
        type
        metadata {
          name
          assets {
            profilePhotoUrl
            __typename
          }
          __typename
        }
        __typename
      }
      id
      isFeatured
      listingDate {
        dateTimeUtc
        label(context: JOB_POSTED, length: SHORT, timezone: $timezone, locale: $locale)
        __typename
      }
      locations {
        countryCode
        label
        seoHierarchy {
          contextualName
          __typename
        }
        __typename
      }
      roleId
      salaryLabel
      solMetadata
      tags {
        label
        type
        __typename
      }
      teaser
      title
      tracking
      workArrangements {
        displayText
        __typename
      }
      workTypes
      __typename
    }
    facets {
      distinctTitle {
        count
        id
        label
        __typename
      }
      location {
        count
        id
        label {
          lang
          text
          __typename
        }
        __typename
      }
      __typename
    }
    queryParamLabels {
      keywords
      locations {
        contextualName {
          text
          __typename
        }
        kind
        __typename
      }
      locationsHierarchy {
        kind
        label {
          text
          __typename
        }
        __typename
      }
      __typename
    }
    info {
      experiment
      newSince
      source
      timeTaken
      __typename
    }
    intentSuggestions {
      count
      id
      label {
        defaultText
        lang
        __typename
      }
      params {
        classification
        companyName
        dateRange
        distance
        keywords
        maxSalary
        minSalary
        salaryType
        siteKey
        sortMode
        subclassification
        tags
        where
        workArrangement
        workTypes
        __typename
      }
      type
      __typename
    }
    isQueryModified
    location {
      defaultDistanceKms
      description
      isGranular
      localisedDescriptions {
        contextualName
        lang
        __typename
      }
      locationDescription
      type
      whereId
      __typename
    }
    searchExecuted {
      classification
      companyName
      dateRange
      distance
      keywords
      maxSalary
      minSalary
      salaryType
      siteKey
      sortMode
      subclassification
      tags
      where
      workArrangement
      workTypes
      __typename
    }
    searchParams {
      advertisergroup
      advertiserid
      basekeywords
      classification
      companyid
      companyname
      companyprofilestructureddataid
      companysearch
      daterange
      distance
      duplicates
      encodedurl
      engineconfig
      eventcapturesessionid
      eventcaptureuserid
      facets
      include
      jobid
      keywords
      locale
      maxlistingdate
      minlistingdate
      newsince
      page
      pagesize
      queryhints
      relatedsearchescount
      salaryrange
      salarytype
      savedsearchid
      sitekey
      solid
      sortmode
      source
      statetoken
      subclassification
      tags
      userid
      userqueryid
      usersessionid
      where
      whereid
      whereids
      workarrangement
      worktype
      __typename
    }
    solMetadata
    sortModes {
      isActive
      name
      value
      __typename
    }
    suggestions {
      asyncPillsToken
      company {
        count
        search {
          companyName
          keywords
          __typename
        }
        __typename
      }
      location {
        description
        whereId
        __typename
      }
      pills {
        isActive
        keywords
        label
        __typename
      }
      relatedSearches {
        keywords
        totalJobs
        __typename
      }
      showSABFilter
      __typename
    }
    totalCount
    userQueryId
    __typename
  }
}`;

/** Process-stable solId — mirrors the `sol_id` cookie set by the SPA on first
 *  load. Must match across cookies AND params or the gateway rejects. */
const PROCESS_SOL_ID = randomUUID();

function buildHeaders(sessionId: string): Record<string, string> {
  // SEEK's gateway hashes incoming requests against an allowlist and rejects
  // mismatches with UNSTABLE_QUERY_ERROR. From a real captured request the
  // following must all be coupled to the SAME per-request UUID:
  //   - cookie JobseekerSessionId
  //   - cookie JobseekerVisitorId
  //   - header x-seek-ec-sessionid
  //   - header x-seek-ec-visitorid
  //   - param  eventCaptureSessionId
  //   - param  eventCaptureUserId
  //   - param  userSessionId
  // And `solId` param must equal the `sol_id` cookie. Rotating any of these
  // independently triggers UNSTABLE_QUERY_ERROR even with a valid query.
  const cookies = [
    `sol_id=${PROCESS_SOL_ID}`,
    `JobseekerSessionId=${sessionId}`,
    `JobseekerVisitorId=${sessionId}`,
  ].join("; ");
  return {
    "content-type": "application/json",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    origin: SEEK_HOST,
    referer: `${SEEK_HOST}/jobs`,
    "seek-request-brand": "jobstreet",
    "seek-request-country": "SG",
    "x-seek-site": "chalice",
    "x-seek-ec-sessionid": sessionId,
    "x-seek-ec-visitorid": sessionId,
    // This header tells SEEK's gateway which query-allowlist signature to
    // validate against. Without it the request hits the strict default
    // and gets rejected with UNSTABLE_QUERY_ERROR.
    "x-custom-features": "application/features.seek.all+json",
    cookie: cookies,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  };
}

interface SeekParams {
  channel: "web";
  siteKey: "SG";
  locale: "en-SG";
  source: "FE_SERP";
  page: number;
  pageSize: number;
  solId: string;
  userQueryId: string;
  userSessionId: string;
  eventCaptureSessionId: string;
  eventCaptureUserId: string;
  include: string[];
  queryHints: string[];
  keywords?: string;
}

function buildParams(req: JobSearchRequest, sessionId: string): SeekParams {
  // SEEK is 1-indexed; our shared API is 0-indexed.
  const page = (req.page ?? 0) + 1;
  const pageSize = Math.min(req.limit ?? 22, 32);
  const params: SeekParams = {
    channel: "web",
    siteKey: "SG",
    locale: "en-SG",
    source: "FE_SERP",
    page,
    pageSize,
    // solId MUST match the sol_id cookie; userQueryId is the only free-rotation field.
    solId: PROCESS_SOL_ID,
    userQueryId: randomUUID(),
    userSessionId: sessionId,
    eventCaptureSessionId: sessionId,
    eventCaptureUserId: sessionId,
    // Match the captured request shape exactly. SEEK validates the param
    // set as part of the query allowlist hash — empty/missing keys here
    // also trigger UNSTABLE_QUERY_ERROR.
    include: ["seoData", "gptTargeting"],
    queryHints: ["spellingCorrection"],
  };
  if (req.query && req.query.trim()) params.keywords = req.query.trim();
  return params;
}

interface SeekRawJob {
  id: string;
  title: string;
  teaser?: string;
  companyName?: string;
  salaryLabel?: string;
  bulletPoints?: string[];
  workTypes?: string[];
  workArrangements?: Array<{ displayText?: string }>;
  classifications?: Array<{
    classification?: { description?: string };
    subclassification?: { description?: string };
  }>;
  locations?: Array<{ label?: string; seoHierarchy?: Array<{ contextualName?: string }> }>;
  listingDate?: { dateTimeUtc?: string };
  branding?: { serpLogoUrl?: string };
  advertiser?: { id?: string; description?: string };
  isFeatured?: boolean;
}

interface SeekResponse {
  data?: {
    jobSearchV6?: {
      data?: SeekRawJob[];
      /** SEEK returns the full result count alongside the page. We pass this
       *  through so the scraper can decide when to stop paginating. */
      totalCount?: number;
    };
  };
  // GraphQL errors come with rich path / extensions info — surface enough of
  // it that a scrape-time failure tells us which field upset the server.
  errors?: Array<{
    message?: string;
    path?: Array<string | number>;
    extensions?: Record<string, unknown>;
  }>;
}

/** Map SEEK's compact workTypes (e.g. "FullTime", "PartTime", "Casual",
 *  "Contract") to our shared EmploymentType union. Anything unknown is dropped
 *  rather than coerced — keeps downstream filtering honest. */
function mapEmploymentType(w: string): EmploymentType | null {
  const t = w.replace(/[\s_-]/g, "").toLowerCase();
  switch (t) {
    case "fulltime":
      return "Full Time";
    case "parttime":
      return "Part Time";
    case "contract":
    case "contracttemp":
      return "Contract";
    case "casual":
    case "casualvacation":
      return "Temporary";
    case "internship":
    case "intern":
      return "Internship";
    case "freelance":
      return "Freelance";
    case "permanent":
      return "Permanent";
    case "flexiwork":
    case "flexible":
      return "Flexi-work";
    default:
      return null;
  }
}

function normalize(r: SeekRawJob): Job | null {
  if (!r.id || !r.title) return null;

  const location = r.locations?.[0]?.label
    ?? r.locations?.[0]?.seoHierarchy?.map((h) => h.contextualName).filter(Boolean).join(", ");

  const categories = (r.classifications ?? [])
    .flatMap((c) => [c.classification?.description, c.subclassification?.description])
    .filter((x): x is string => !!x);

  const employmentTypes = (r.workTypes ?? [])
    .map(mapEmploymentType)
    .filter((x): x is EmploymentType => x !== null);

  // SEEK provides a teaser (~150 chars) but no full HTML description in the
  // search payload — the detail page fetches the long form separately. For
  // listing purposes the teaser + bullets are usually enough; consumers
  // requesting detail can call seekGetJob (TODO once we capture that XHR).
  const bullets = r.bulletPoints?.length
    ? "\n\n" + r.bulletPoints.map((b) => `• ${b}`).join("\n")
    : "";
  const descriptionText = `${r.teaser ?? ""}${bullets}`.trim();

  return {
    id: `seek:${r.id}`,
    source: "seek",
    sourceId: r.id,
    url: `${SEEK_HOST}/job/${r.id}`,
    title: r.title,
    company: {
      name: r.companyName ?? r.advertiser?.description ?? "Unknown",
      logoUrl: r.branding?.serpLogoUrl,
    },
    // No HTML description in search payload; mirror the text into both fields
    // so consumers that read `description` still get something.
    description: descriptionText,
    descriptionText: descriptionText || undefined,
    location,
    employmentTypes,
    // SEEK doesn't expose a seniority field on search results — left empty.
    // Local seniority filter will simply exclude SEEK results when active;
    // that's the honest behavior, no fabrication.
    seniority: [] as SeniorityLevel[],
    categories,
    skills: [],
    // Parsed from SEEK's salaryLabel string. parseSalaryLabel returns
    // undefined when the label is missing or unparseable — never coerces.
    salary: parseSalaryLabel(r.salaryLabel),
    postedDate: r.listingDate?.dateTimeUtc,
  };
}

/** Detail query, pasted VERBATIM from a real SPA capture (May 2026).
 *  SEEK's gateway hashes the incoming query + variable shape against an
 *  allowlist and rejects mismatches with UNSTABLE_QUERY_ERROR. Do NOT trim
 *  fields — even removing one __typename will re-break it. We still parse
 *  only what we need via the narrow SeekDetailResponse interface below;
 *  the rest of the response just rides along on the wire. */
const JOB_DETAIL_QUERY = `query jobDetails($jobId: ID!, $jobDetailsViewedCorrelationId: String!, $sessionId: String!, $zone: Zone!, $locale: Locale!, $languageCode: LanguageCodeIso!, $countryCode: CountryCodeIso2!, $timezone: Timezone!, $visitorId: UUID!, $isAuthenticated: Boolean!, $enableJdvBadge: Boolean!, $enableClickToReveal: Boolean!) {
  jobDetails(
    id: $jobId
    tracking: {channel: "WEB", jobDetailsViewedCorrelationId: $jobDetailsViewedCorrelationId, sessionId: $sessionId}
  ) {
    ...job
    insights @include(if: $isAuthenticated) {
      ... on ApplicantCount {
        volumeLabel(locale: $locale)
        count
        __typename
      }
      __typename
    }
    learningInsights(platform: WEB, zone: $zone, locale: $locale) {
      analytics
      content
      __typename
    }
    gfjInfo {
      location {
        countryCode
        country(locale: $locale)
        suburb(locale: $locale)
        region(locale: $locale)
        state(locale: $locale)
        postcode
        __typename
      }
      workTypes {
        label
        __typename
      }
      company {
        url(locale: $locale, zone: $zone)
        __typename
      }
      __typename
    }
    workArrangements(visitorId: $visitorId, channel: "JDV", platform: WEB) {
      arrangements {
        type
        label(locale: $locale)
        __typename
      }
      label(locale: $locale)
      __typename
    }
    seoInfo {
      normalisedRoleTitle
      workType
      classification
      subClassification
      where(zone: $zone)
      broaderLocationName(locale: $locale)
      normalisedOrganisationName
      __typename
    }
    __typename
  }
}

fragment badges on JobDetails {
  badges(visitorId: $visitorId, platform: WEB, locale: $locale) @include(if: $enableJdvBadge) {
    badges {
      badge
      displayText(locale: $locale)
      ... on JobDetailsInteractiveBadge {
        message(locale: $locale, zone: $zone)
        __typename
      }
      ... on JobDetailsResponsiveHirerBadge {
        message(locale: $locale, zone: $zone)
        badgeScore
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}

fragment job on JobDetails {
  job {
    sourceZone
    tracking {
      adProductType
      classificationInfo {
        classificationId
        classification
        subClassificationId
        subClassification
        __typename
      }
      hasRoleRequirements
      isPrivateAdvertiser
      locationInfo {
        area
        location
        locationIds
        __typename
      }
      workTypeIds
      postedTime
      __typename
    }
    id
    title
    phoneNumber
    isExpired
    expiresAt {
      dateTimeUtc
      __typename
    }
    isLinkOut
    contactMatches {
      type
      value
      __typename
    }
    isVerified
    abstract
    content(platform: WEB) @skip(if: $enableClickToReveal)
    content2(zone: $zone) @include(if: $enableClickToReveal)
    status
    listedAt {
      label(context: JOB_POSTED, length: SHORT, timezone: $timezone, locale: $locale)
      dateTimeUtc
      __typename
    }
    salary {
      currencyLabel(zone: $zone)
      label
      __typename
    }
    shareLink(platform: WEB, zone: $zone, locale: $locale)
    workTypes {
      label(locale: $locale)
      __typename
    }
    advertiser {
      id
      name(locale: $locale)
      isVerified
      registrationDate {
        dateTimeUtc
        __typename
      }
      __typename
    }
    location {
      label(locale: $locale, type: LONG)
      __typename
    }
    classifications {
      label(languageCode: $languageCode)
      __typename
    }
    products {
      branding {
        id
        cover {
          url
          __typename
        }
        thumbnailCover: cover(isThumbnail: true) {
          url
          __typename
        }
        logo {
          url
          __typename
        }
        __typename
      }
      bullets
      questionnaire {
        questions
        __typename
      }
      video {
        url
        position
        __typename
      }
      __typename
    }
    __typename
  }
  ...badges
  companyProfile(zone: $zone) {
    id
    name
    companyNameSlug
    shouldDisplayReviews
    branding {
      logo
      __typename
    }
    overview {
      description {
        paragraphs
        __typename
      }
      industry
      size {
        description
        __typename
      }
      website {
        url
        __typename
      }
      __typename
    }
    reviewsSummary {
      overallRating {
        numberOfReviews {
          value
          __typename
        }
        value
        __typename
      }
      __typename
    }
    perksAndBenefits {
      title
      __typename
    }
    __typename
  }
  companySearchUrl(zone: $zone, languageCode: $languageCode)
  companyTags {
    key(languageCode: $languageCode)
    value
    __typename
  }
  restrictedApplication(countryCode: $countryCode) {
    label(locale: $locale)
    __typename
  }
  sourcr {
    image
    imageMobile
    link
    __typename
  }
  __typename
}`;

interface SeekDetailResponse {
  data?: {
    jobDetails?: {
      job?: {
        id: string;
        title?: string;
        abstract?: string;
        /** Present when enableClickToReveal=false; we send true, so this is
         *  typically null/missing — content2 is the field that actually carries
         *  the HTML body. Kept here as a fallback in case the gateway flips. */
        content?: string;
        content2?: string;
        isExpired?: boolean;
        isLinkOut?: boolean;
        phoneNumber?: string;
        expiresAt?: { dateTimeUtc?: string };
        listedAt?: { dateTimeUtc?: string };
        salary?: { label?: string };
        shareLink?: string;
        location?: { label?: string };
        advertiser?: { name?: string };
        tracking?: {
          classificationInfo?: { classification?: string; subClassification?: string };
          locationInfo?: { location?: string; area?: string };
          workTypeIds?: string[];
        };
      };
      workArrangements?: {
        arrangements?: Array<{ type?: string; label?: string }>;
      };
      companyProfile?: {
        name?: string;
        branding?: { logo?: string };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

/** Parse SEEK's salary label string ("$5,000 – $7,000 per month",
 *  "$80k – $120k a year", "From $4,000 per month", "Up to $10,000")
 *  into structured min/max + period. Returns undefined when nothing parses
 *  cleanly — we never coerce a guess (would break salary filters). */
function parseSalaryLabel(label: string | undefined): Job["salary"] {
  if (!label) return undefined;
  const s = label.replace(/,/g, "");

  // Period detection — defaults to monthly which matches MCF convention.
  const periodMatch = /per\s+(hour|day|month|year|annum)|a\s+(year|month|hour|day)|annual/i.exec(s);
  const periodWord = (periodMatch?.[1] ?? periodMatch?.[2] ?? "month").toLowerCase();
  const period: NonNullable<Job["salary"]>["period"] =
    periodWord === "annum" || periodWord === "year"
      ? "annual"
      : periodWord === "hour"
        ? "hourly"
        : periodWord === "day"
          ? "daily"
          : "monthly";

  // Pull numbers — supports "$5000", "$5k", "$5,000". We already stripped commas.
  const numbers = Array.from(s.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k|K)?/g)).map((m) => {
    const n = parseFloat(m[1] ?? "0");
    return m[2] ? n * 1000 : n;
  });

  if (numbers.length === 0) return undefined;
  const [a, b] = numbers;

  // "From $X" / "Up to $X" → single-sided ranges.
  if (/^\s*from/i.test(label) || numbers.length === 1) {
    return { min: a, currency: "SGD", period };
  }
  if (/up\s*to/i.test(label)) {
    return { max: a, currency: "SGD", period };
  }
  return { min: a, max: b, currency: "SGD", period };
}

export async function seekGetJob(jobId: string): Promise<Job | null> {
  // Per-request session UUID, coupled across cookies + headers + the
  // `sessionId` body variable. visitorId (body) mirrors sol_id (cookie). See
  // buildHeaders for the full coupling matrix — any mismatch trips
  // UNSTABLE_QUERY_ERROR on the gateway.
  const sessionId = randomUUID();
  const body = {
    operationName: "jobDetails",
    variables: {
      jobId,
      jobDetailsViewedCorrelationId: randomUUID(),
      sessionId,
      zone: "asia-7",
      locale: "en-SG",
      languageCode: "en",
      countryCode: "SG",
      timezone: "Asia/Singapore",
      visitorId: PROCESS_SOL_ID,
      isAuthenticated: false,
      enableJdvBadge: true,
      enableClickToReveal: true,
    },
    query: JOB_DETAIL_QUERY,
  };

  const res = await fetch(SEEK_GRAPHQL, {
    method: "POST",
    headers: buildHeaders(sessionId),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SEEK detail ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as SeekDetailResponse;
  if (raw.errors?.length) {
    throw new Error(`SEEK detail GraphQL: ${raw.errors.map((e) => e.message).join("; ")}`);
  }
  const j = raw.data?.jobDetails?.job;
  if (!j || !j.id || !j.title) return null;

  // enableClickToReveal=true selects content2; content is @skipped. Fall back
  // to content (in case the gateway ever flips) then abstract.
  const descriptionHtml = j.content2 ?? j.content ?? j.abstract ?? "";
  const descriptionText = descriptionHtml ? stripHtml(descriptionHtml) : undefined;

  const cls = j.tracking?.classificationInfo;
  const categories = [cls?.classification, cls?.subClassification].filter(
    (x): x is string => !!x,
  );

  // Detail query now exposes a richer location.label; fall back to the older
  // tracking fields, then to "Singapore" as a last resort.
  const location = j.location?.label
    ?? j.tracking?.locationInfo?.location
    ?? j.tracking?.locationInfo?.area
    ?? "Singapore";

  // Work arrangements give us remote/hybrid/onsite as a typed signal — fold
  // into the categories array for now so existing filters see them as facets.
  const arrangements = (raw.data?.jobDetails?.workArrangements?.arrangements ?? [])
    .map((a) => a.label)
    .filter((x): x is string => !!x);

  // Prefer the company-profile name (locale-aware) over the listing's advertiser name.
  const companyName =
    raw.data?.jobDetails?.companyProfile?.name
    ?? j.advertiser?.name
    ?? "Unknown";
  const companyLogo = raw.data?.jobDetails?.companyProfile?.branding?.logo;

  return {
    id: `seek:${j.id}`,
    source: "seek",
    sourceId: j.id,
    url: j.shareLink ?? `${SEEK_HOST}/job/${j.id}`,
    title: j.title,
    company: { name: companyName, logoUrl: companyLogo },
    description: descriptionHtml,
    descriptionText,
    location,
    // workTypeIds are numeric SEEK codes — leave employmentTypes empty here.
    // The search payload already mapped workTypes for the snapshot; detail
    // fetches are mostly used for description enrichment, not type filtering.
    employmentTypes: [],
    seniority: [],
    categories: [...categories, ...arrangements],
    skills: [],
    salary: parseSalaryLabel(j.salary?.label),
    postedDate: j.listedAt?.dateTimeUtc,
    expiryDate: j.expiresAt?.dateTimeUtc,
    // insights are gated on isAuthenticated=true; we send false, so this is
    // always missing for now. Left as a no-op rather than removed in case
    // we ever want to flip authentication on.
    applicantCount: undefined,
    raw,
  };
}

/** Minimal HTML stripper — used for SEEK content. Mirrors the one in mcf.ts;
 *  we don't share the helper across files to keep the adapters independent.
 *  When we add `scraper/src/normalize.ts` for the dedup pass, both adapters
 *  will lift their copies up to that shared module. */
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

export async function seekSearch(req: JobSearchRequest): Promise<SeekSearchResult> {
  const sessionId = randomUUID();
  const params = buildParams(req, sessionId);
  const body = {
    operationName: "JobSearchV6",
    variables: {
      params,
      locale: "en-SG",
      timezone: "Asia/Singapore",
    },
    query: JOB_SEARCH_QUERY,
  };

  const res = await fetch(SEEK_GRAPHQL, {
    method: "POST",
    headers: buildHeaders(sessionId),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SEEK ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = (await res.json()) as SeekResponse;
  if (raw.errors?.length) {
    // Surface enough detail to actually debug — message alone is usually
    // "An error occurred." The path tells you which field upset the server,
    // extensions usually carry the real cause (code, classification).
    const detail = raw.errors
      .map((e) => {
        const path = e.path ? `@${e.path.join(".")}` : "";
        const ext = e.extensions ? ` ${JSON.stringify(e.extensions)}` : "";
        return `${e.message ?? "(no message)"}${path}${ext}`;
      })
      .join(" | ");
    throw new Error(`SEEK GraphQL: ${detail}`);
  }

  const list = raw.data?.jobSearchV6?.data ?? [];
  const results = list.map(normalize).filter((j): j is Job => j !== null);
  const total = raw.data?.jobSearchV6?.totalCount ?? results.length;

  return {
    normalized: {
      results,
      total,
      page: req.page ?? 0,
      limit: params.pageSize,
    },
    raw,
  };
}
