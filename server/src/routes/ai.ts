import { Hono } from "hono";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  CoverLetterTone,
  Job,
  MatchBatchRequest,
  MatchBatchResponse,
  MatchScoreLite,
  Resume,
} from "@aggregator/shared";
import {
  anthropic,
  extractJson,
  MODEL_HAIKU,
  MODEL_SONNET,
} from "../lib/anthropic.js";
import { rateLimit } from "../lib/rateLimit.js";
import { sse } from "../lib/sse.js";

export const aiRoute = new Hono();

// ---------------- Shared prompt fragments ----------------

const NEVER_FABRICATE = `CRITICAL — Never invent, fabricate, or embellish:
- No invented employers, dates, degrees, titles, certifications, or skills.
- No invented quantitative claims ("led team of 12", "30% improvement") unless
  those exact numbers appear in the source resume.
- If the job calls for something the candidate genuinely lacks, surface it as
  a gap. Do not paper over it.
- Use the candidate's own voice and phrasing where possible.`;

const JSON_ONLY = `Return JSON only. No preamble, no markdown fences, no commentary outside the JSON object.`;

function contextBlock(resume: Resume, job: Job): string {
  return `=== JOB ===
Title: ${job.title}
Company: ${job.company.name}
Employment: ${job.employmentTypes.join(", ") || "n/a"}
Seniority: ${job.seniority.join(", ") || "n/a"}
Skills: ${job.skills.join(", ") || "n/a"}
Description:
${job.descriptionText ?? job.description ?? ""}

=== RESUME ===
${JSON.stringify(resume, null, 2)}`;
}

// ---------------- /parse-resume (non-streaming) ----------------

const PARSE_RESUME_SYSTEM = `You extract structured data from resume text.

${NEVER_FABRICATE}
If a field is not present in the source, return an empty string or empty array.
Preserve the candidate's own wording in bullets and summary — do not paraphrase.
Dates: keep the candidate's original format. Use "Present" for current roles.

${JSON_ONLY}

Output schema (strict — return exactly these keys):
{
  "contact": { "name": string, "email": string, "phone": string, "location": string, "links": string[] },
  "summary": string,
  "experiences": [{ "title": string, "company": string, "location": string, "startDate": string, "endDate": string, "current": boolean, "bullets": string[] }],
  "education": [{ "degree": string, "institution": string, "startDate": string, "endDate": string, "gpa": string }],
  "skills": { "technical": string[], "soft": string[], "languages": string[], "tools": string[] },
  "projects": [{ "name": string, "description": string, "technologies": string[], "link": string }],
  "certifications": string[]
}`;

function coerceResume(raw: unknown): Resume {
  const r = (raw ?? {}) as Record<string, unknown>;
  const contact = (r.contact ?? {}) as Record<string, unknown>;
  const skills = (r.skills ?? {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  return {
    contact: {
      name: str(contact.name),
      email: str(contact.email) || undefined,
      phone: str(contact.phone) || undefined,
      location: str(contact.location) || undefined,
      links: arr<string>(contact.links).filter((s) => typeof s === "string"),
    },
    summary: str(r.summary),
    experiences: arr<Record<string, unknown>>(r.experiences).map((e) => ({
      title: str(e.title),
      company: str(e.company),
      location: str(e.location) || undefined,
      startDate: str(e.startDate) || undefined,
      endDate: str(e.endDate) || undefined,
      current: Boolean(e.current),
      bullets: arr<string>(e.bullets).filter((s) => typeof s === "string"),
    })),
    education: arr<Record<string, unknown>>(r.education).map((e) => ({
      degree: str(e.degree),
      institution: str(e.institution),
      startDate: str(e.startDate) || undefined,
      endDate: str(e.endDate) || undefined,
      gpa: str(e.gpa) || undefined,
    })),
    skills: {
      technical: arr<string>(skills.technical).filter((s) => typeof s === "string"),
      soft: arr<string>(skills.soft).filter((s) => typeof s === "string"),
      languages: arr<string>(skills.languages).filter((s) => typeof s === "string"),
      tools: arr<string>(skills.tools).filter((s) => typeof s === "string"),
    },
    projects: arr<Record<string, unknown>>(r.projects).map((p) => ({
      name: str(p.name),
      description: str(p.description),
      technologies: arr<string>(p.technologies).filter((s) => typeof s === "string"),
      link: str(p.link) || undefined,
    })),
    certifications: arr<string>(r.certifications).filter((s) => typeof s === "string"),
  };
}

aiRoute.post("/parse-resume", async (c) => {
  let body: { text?: string };
  try {
    body = (await c.req.json()) as { text?: string };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const text = body.text?.trim();
  if (!text) return c.json({ error: "Missing `text`" }, 400);
  if (text.length > 50_000) {
    return c.json({ error: "Resume text too long (>50k chars)" }, 413);
  }

  try {
    const msg = await anthropic().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 4096,
      system: PARSE_RESUME_SYSTEM,
      messages: [{ role: "user", content: text }],
    });
    const out = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = extractJson(out);
    const resume = coerceResume(parsed);
    return c.json({ resume });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Parse failed", detail: message }, 502);
  }
});

// ---------------- Streaming helpers ----------------

interface JobResumeBody {
  resume?: Resume;
  job?: Job;
}

interface CoverLetterBody extends JobResumeBody {
  tone?: CoverLetterTone;
  /** Career-transition mode — applies a different system prompt. */
  mode?: "default" | "transition";
}

interface TailorBody extends JobResumeBody {
  mode?: "default" | "transition";
}

function validateJobResume(body: unknown): { resume: Resume; job: Job } | string {
  const b = (body ?? {}) as JobResumeBody;
  if (!b.resume || typeof b.resume !== "object") return "Missing `resume`";
  if (!b.job || typeof b.job !== "object") return "Missing `job`";
  return { resume: b.resume, job: b.job };
}

async function pipeAnthropicStream(
  params: Anthropic.MessageCreateParamsStreaming,
  emit: (ev: { type: "delta"; text: string }) => Promise<void>,
): Promise<void> {
  const stream = anthropic().messages.stream(params);
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      await emit({ type: "delta", text: event.delta.text });
    }
  }
}

// ---------------- /match-score (streaming) ----------------

const MATCH_SCORE_SYSTEM = `You score how well a candidate's resume matches a job description.

${NEVER_FABRICATE}

Scoring guidance:
- 0–49: significant gaps in core requirements
- 50–74: meets most requirements, some gaps
- 75–89: strong match, minor gaps
- 90–100: exceptional, near-perfect match

In addition to the score, categorize the dominant reason for any significant
gap so the UI can route the user to the right next action.

${JSON_ONLY}

Output schema:
{
  "score": number,                // 0-100 integer
  "gap_category": "industry" | "skills" | "seniority" | "experience" | "location" | "none",
  "strengths": string[],          // 3-5 specific matches (resume evidence + JD requirement)
  "gaps": string[],               // 2-4 genuine gaps
  "hidden_strengths": string[],   // 1-3 things the candidate may not realize are relevant
  "suggestions": string[]         // 2-3 concrete actions
}`;

aiRoute.post("/match-score", rateLimit("haiku"), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const v = validateJobResume(body);
  if (typeof v === "string") return c.json({ error: v }, 400);

  return sse(c, {
    run: async (emit) => {
      await pipeAnthropicStream(
        {
          model: MODEL_HAIKU,
          max_tokens: 1024,
          system: MATCH_SCORE_SYSTEM,
          messages: [{ role: "user", content: contextBlock(v.resume, v.job) }],
          stream: true,
        },
        emit,
      );
    },
  });
});

// ---------------- /tailor-resume (streaming, mode-aware) ----------------

const TAILOR_DEFAULT = `You tailor a resume to a specific job posting.

${NEVER_FABRICATE}

What you may do:
- Reorder experiences or bullets to put the most relevant content first.
- Rephrase existing bullets to mirror the JD's keywords WHERE the underlying
  experience genuinely supports it.
- Adjust the summary to emphasize existing skills the JD cares about.
- Suggest re-emphasizing skills that already appear in the resume.

What you must NOT do:
- Add new bullets, experiences, skills, or numbers not present in the source.
- Change job titles, employers, or dates.`;

const TAILOR_TRANSITION = `You tailor a resume for a candidate intentionally transitioning into a
different industry or function from the one their resume centers on.

${NEVER_FABRICATE}

Career-transition guidance — the candidate KNOWS this is a stretch:
- Do not soften or hide the gap. Don't pretend the candidate has industry
  experience they don't have.
- Open the summary with a single sentence naming the transition explicitly
  (e.g. "Operations leader transitioning into product management").
- Reorder experiences and bullets to lead with TRANSFERABLE work — anything
  showing the underlying competency the new role needs (judgment under
  ambiguity, stakeholder management, technical depth, customer empathy, etc.).
- Rephrase bullets to surface the transferable angle without inventing facts.
- In the gaps[] field, be unflinching about what's genuinely missing — the
  candidate will address those in interviews.`;

const TAILOR_SCHEMA = `${JSON_ONLY}

Output schema:
{
  "summary": string,
  "experiences": [
    {
      "title": string, "company": string, "location": string,
      "startDate": string, "endDate": string, "current": boolean,
      "bullets": string[]
    }
  ],
  "changes": string[],
  "gaps": string[]
}`;

aiRoute.post("/tailor-resume", rateLimit("sonnet"), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const v = validateJobResume(body);
  if (typeof v === "string") return c.json({ error: v }, 400);
  const mode = (body as TailorBody).mode ?? "default";

  const system =
    (mode === "transition" ? TAILOR_TRANSITION : TAILOR_DEFAULT) +
    "\n\n" +
    TAILOR_SCHEMA;

  return sse(c, {
    run: async (emit) => {
      await pipeAnthropicStream(
        {
          model: MODEL_SONNET,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: contextBlock(v.resume, v.job) }],
          stream: true,
        },
        emit,
      );
    },
  });
});

// ---------------- /cover-letter (streaming, mode-aware) ----------------

function coverLetterSystem(tone: CoverLetterTone, mode: "default" | "transition"): string {
  const toneGuide = {
    formal:
      "Tone: formal and professional. No contractions. Standard business-letter conventions.",
    conversational:
      "Tone: warm and conversational. Use contractions. Write like you'd talk to a smart colleague.",
    enthusiastic:
      "Tone: enthusiastic and energetic, but still substantive. Avoid hype words.",
  }[tone];

  const transitionGuide =
    mode === "transition"
      ? `\n\nCareer-transition framing:
- The candidate is intentionally pivoting. Lead the first paragraph with one
  honest sentence naming the transition.
- Body paragraphs ground 2-3 transferable competencies in concrete resume
  evidence — show the underlying capability the new role needs.
- Close with a specific reason this role's domain is interesting to them.
- Never apologize for the gap or use weak phrasing like "even though" or
  "despite". Frame the transition as deliberate.`
      : "";

  return `You write cover letters from a candidate's resume and a job posting.

${NEVER_FABRICATE}

${toneGuide}${transitionGuide}

Constraints:
- 3-4 short paragraphs. Maximum ~300 words.
- Open with a specific reason the candidate is interested (anchored in the JD).
- Middle paragraphs cite 2-3 concrete pieces of evidence from the resume.
- Close with a clear call to action.
- Output prose only — no markdown headers, no bullet lists, no preamble.`;
}

aiRoute.post("/cover-letter", rateLimit("sonnet"), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const v = validateJobResume(body);
  if (typeof v === "string") return c.json({ error: v }, 400);
  const tone = (body as CoverLetterBody).tone ?? "conversational";
  const mode = (body as CoverLetterBody).mode ?? "default";

  return sse(c, {
    run: async (emit) => {
      await pipeAnthropicStream(
        {
          model: MODEL_SONNET,
          max_tokens: 1024,
          system: coverLetterSystem(tone, mode),
          messages: [{ role: "user", content: contextBlock(v.resume, v.job) }],
          stream: true,
        },
        emit,
      );
    },
  });
});

// ---------------- ATS auto-fix endpoints ----------------

const REWRITE_BULLET_SYSTEM = `You rewrite a single resume bullet to be stronger
for an ATS, while staying truthful to the original.

${NEVER_FABRICATE}

What you may do:
- Replace weak openers ("Responsible for", "Worked on", "Helped") with strong
  action verbs (Led, Built, Shipped, Designed, Drove, Owned, Reduced, Scaled).
- Make the bullet more concise.
- Move the impact/outcome to the front when an outcome is genuinely present
  in the original.

What you must NOT do:
- Invent metrics, numbers, percentages, or team sizes not in the original.
- Add new responsibilities or claims.
- Change the underlying meaning.

Return three alternative rewrites — varied in style and emphasis — so the
candidate can pick the one that sounds most like them.

${JSON_ONLY}

Output schema:
{
  "alternatives": [
    { "text": string, "rationale": string },
    { "text": string, "rationale": string },
    { "text": string, "rationale": string }
  ]
}`;

aiRoute.post("/atsfix/bullet", rateLimit("haiku"), async (c) => {
  let body: { bullet?: string; context?: { title?: string; company?: string } };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const bullet = body.bullet?.trim();
  if (!bullet) return c.json({ error: "Missing `bullet`" }, 400);

  const ctx = body.context
    ? `Context — role: ${body.context.title ?? "(unknown)"} at ${body.context.company ?? "(unknown)"}\n\n`
    : "";

  try {
    const msg = await anthropic().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 800,
      system: REWRITE_BULLET_SYSTEM,
      messages: [
        { role: "user", content: `${ctx}Original bullet:\n${bullet}` },
      ],
    });
    const out = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = extractJson(out) as {
      alternatives?: Array<{ text?: string; rationale?: string }>;
    };
    const alternatives = (parsed.alternatives ?? [])
      .filter((a) => typeof a.text === "string" && a.text.trim())
      .map((a) => ({ text: a.text!, rationale: a.rationale ?? "" }));
    return c.json({ alternatives });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Rewrite failed", detail: message }, 502);
  }
});

const EXTRACT_SKILLS_SYSTEM = `You find skills mentioned in a candidate's resume
that are NOT already in their dedicated Skills section.

${NEVER_FABRICATE}

Source the skills from concrete evidence in their bullets or project
descriptions. If a skill appears in a bullet (e.g. "deployed services to AWS"
→ "AWS"), surface it. Do not surface anything not directly in the text.

Categorize each surfaced skill as one of: "technical", "tools", "languages",
"soft".

${JSON_ONLY}

Output schema:
{
  "extracted": [
    { "name": string, "category": "technical" | "tools" | "languages" | "soft", "evidence": string }
  ]
}`;

aiRoute.post("/atsfix/extract-skills", rateLimit("haiku"), async (c) => {
  let body: { resume?: Resume };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.resume) return c.json({ error: "Missing `resume`" }, 400);

  try {
    const msg = await anthropic().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1024,
      system: EXTRACT_SKILLS_SYSTEM,
      messages: [
        { role: "user", content: JSON.stringify(body.resume, null, 2) },
      ],
    });
    const out = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = extractJson(out) as {
      extracted?: Array<{
        name?: string;
        category?: string;
        evidence?: string;
      }>;
    };
    const valid = ["technical", "tools", "languages", "soft"] as const;
    const extracted = (parsed.extracted ?? [])
      .filter(
        (e): e is { name: string; category: (typeof valid)[number]; evidence: string } =>
          typeof e.name === "string" &&
          !!e.name.trim() &&
          (valid as readonly string[]).includes(e.category ?? "") &&
          typeof e.evidence === "string",
      );
    return c.json({ extracted });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Extraction failed", detail: message }, 502);
  }
});

const GEN_SUMMARY_SYSTEM = `You generate a 2-3 sentence professional summary for the
top of a resume.

${NEVER_FABRICATE}

Source every claim from the experiences, skills, and education already in the
resume. Mirror the candidate's own phrasing where possible. No first-person
("I"); use the typical resume-summary voice. Plain text only.`;

aiRoute.post("/atsfix/summary", rateLimit("haiku"), async (c) => {
  let body: { resume?: Resume };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.resume) return c.json({ error: "Missing `resume`" }, 400);

  try {
    const msg = await anthropic().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 400,
      system: GEN_SUMMARY_SYSTEM,
      messages: [
        { role: "user", content: JSON.stringify(body.resume, null, 2) },
      ],
    });
    const summary = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return c.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Summary generation failed", detail: message }, 502);
  }
});

// ---------------- /match-batch (non-streaming, single Haiku call) ----------------
//
// Scores up to 30 jobs against a resume in one call. Trades the per-job depth
// of /match-score (full strengths/gaps/suggestions) for ranking-grade output:
// just `{jobId, score, rationale}` per row. This is what powers match-aware
// list sorting — caller batches the visible page, sorts by returned scores,
// caches per (jobId, resumeHash).
//
// Rate-limited under "haiku" because the cost is dominated by input tokens
// (we ship the full job + resume each call). 200/day is generous.

const MATCH_BATCH_SYSTEM = `You are a career-matching expert ranking jobs against a candidate's resume.

For each job, output a 0-100 score and ONE sentence of rationale.

${NEVER_FABRICATE}

Score calibration (don't drift from this):
- 85-100 = clear strong match (skills + seniority + industry align)
- 70-84  = good match with minor gaps (1-2 missing skills, adjacent industry)
- 50-69  = partial fit (transferable but visible gaps)
- 30-49  = significant mismatch (different industry OR seniority gap)
- 0-29   = mismatch / role candidate is unlikely to land

Rationale = ONE sentence. Cite the strongest evidence (skill, role, industry).
Do NOT pad with generic praise.

${JSON_ONLY}

Output schema:
{ "scores": [{ "jobId": string, "score": number, "rationale": string }] }`;

const MAX_BATCH_SIZE = 30;

aiRoute.post("/match-batch", rateLimit("haiku"), async (c) => {
  let body: MatchBatchRequest;
  try {
    body = (await c.req.json()) as MatchBatchRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.jobs?.length) return c.json({ error: "No jobs provided" }, 400);
  if (!body.resume) return c.json({ error: "No resume provided" }, 400);
  if (body.jobs.length > MAX_BATCH_SIZE) {
    return c.json(
      { error: `Batch limit is ${MAX_BATCH_SIZE} jobs (received ${body.jobs.length})` },
      400,
    );
  }

  // Compact job representation — keeps the prompt small. Title + company +
  // employment + seniority + skills + first 500 chars of description is
  // plenty for ranking, and 30 of these fits comfortably under Haiku's
  // 200k context.
  const jobBlock = body.jobs
    .map((j) => {
      const desc = (j.descriptionText ?? j.description ?? "").slice(0, 500);
      return `--- ${j.id} ---
Title: ${j.title}
Company: ${j.company.name}
Seniority: ${j.seniority.join(", ") || "n/a"}
Skills: ${j.skills.join(", ") || "n/a"}
Employment: ${j.employmentTypes.join(", ") || "n/a"}
Description: ${desc}`;
    })
    .join("\n\n");

  const userPrompt = `=== JOBS ===
${jobBlock}

=== RESUME ===
${JSON.stringify(body.resume, null, 2)}

Return scores for ALL ${body.jobs.length} jobs. Use the exact jobId values above.`;

  try {
    const msg = await anthropic().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 2048,
      system: MATCH_BATCH_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsedRaw = extractJson(text) as { scores?: unknown[] } | null;
    const scores: MatchScoreLite[] = (parsedRaw?.scores ?? []).filter(
      (s): s is MatchScoreLite => {
        if (typeof s !== "object" || s === null) return false;
        const o = s as Record<string, unknown>;
        return (
          typeof o.jobId === "string" &&
          typeof o.score === "number" &&
          typeof o.rationale === "string"
        );
      },
    );
    // Guard against the model dropping jobs — backfill missing ids with a
    // neutral score so the client never sees a silently-missing entry.
    const seen = new Set(scores.map((s) => s.jobId));
    for (const j of body.jobs) {
      if (!seen.has(j.id)) {
        scores.push({ jobId: j.id, score: 50, rationale: "(not scored)" });
      }
    }
    const resp: MatchBatchResponse = {
      resumeHash: body.resumeHash ?? "",
      scores,
    };
    return c.json(resp);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Batch matching failed", detail: message }, 502);
  }
});

// ---------------- /interview-prep (streaming) ----------------
//
// Streams a complete InterviewPrep payload as one JSON object. We don't
// frame each question separately because the question set is interdependent
// (the model balances behavioral / technical / culture-fit). Single
// streamed JSON keeps the consumer simple.
//
// Uses Sonnet because question quality is the value prop — Haiku gives
// generic "tell me about a time you led a team" filler. Rate-limited under
// "sonnet".

const INTERVIEW_PREP_SYSTEM = `You generate interview preparation for a specific job and candidate.

${NEVER_FABRICATE}

Produce 6-8 likely interview questions, weighted toward the role's specifics
(read the job description carefully). For each:
- "question" — what the interviewer will likely ask, in their voice
- "why" — one sentence on why this question is probable (cite JD evidence
  or resume gaps)
- "star" — a draft STAR-method answer ANCHORED in the candidate's actual
  experience bullets. If no relevant bullet exists, set star to null and
  flag the gap in red_flags. NEVER invent experiences.
- "tags" — subset of ["behavioral", "technical", "culture-fit", "experience"]

Also produce 2-3 red_flags — concerns the interviewer is likely to raise
(employment gaps, short tenure, career changes, missing required skill).
Each red_flag has a "concern" and a "suggested_response" — honest framing,
no spin.

Finally, list 3-5 prep_topics — specific things to brush up on before
the interview (technologies named in the JD, company recent news, role
expectations).

${JSON_ONLY}

Output schema:
{
  "questions": [{
    "question": string,
    "why": string,
    "star": { "situation": string, "task": string, "action": string, "result": string } | null,
    "tags": string[]
  }],
  "red_flags": [{ "concern": string, "suggested_response": string }],
  "prep_topics": string[]
}`;

aiRoute.post("/interview-prep", rateLimit("sonnet"), async (c) => {
  let body: { resume: Resume; job: Job };
  try {
    body = (await c.req.json()) as { resume: Resume; job: Job };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.resume || !body.job) {
    return c.json({ error: "resume and job are required" }, 400);
  }

  return sse(c, {
    run: async (emit) => {
      const stream = anthropic().messages.stream({
        model: MODEL_SONNET,
        max_tokens: 4096,
        system: INTERVIEW_PREP_SYSTEM,
        messages: [
          { role: "user", content: contextBlock(body.resume, body.job) },
        ],
      });
      let acc = "";
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          acc += event.delta.text;
          await emit({ type: "delta", text: event.delta.text });
        }
      }
      // Final parsed payload — the sse() wrapper will emit `done` after this
      // returns. We intentionally don't ship the parsed JSON in the event;
      // the client re-parses the accumulated `delta` stream for resilience.
      void extractJson(acc);
    },
  });
});
