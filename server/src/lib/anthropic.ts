import Anthropic from "@anthropic-ai/sdk";

// Model IDs per brief.
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";
export const MODEL_SONNET = "claude-sonnet-4-6";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to server/.env before using AI routes.",
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Extract the first top-level JSON object from a string (tolerant of fences and preamble). */
export function extractJson(text: string): unknown {
  // Strip fenced markdown if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
