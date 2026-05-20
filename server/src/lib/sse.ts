// Server-Sent Events helpers for streaming Anthropic responses to the client.
//
// Event protocol (kept simple and uniform across all AI routes):
//   data: {"type":"delta","text":"..."}      — incremental text chunk
//   data: {"type":"done"}                     — stream finished cleanly
//   data: {"type":"error","message":"..."}    — terminal failure
//
// The client just accumulates `text` from `delta` events and dispatches on
// `done` / `error`. Endpoints that return structured JSON ship the full JSON
// in one or more deltas and the client parses on `done`.

import { stream } from "hono/streaming";
import type { Context } from "hono";

export type SseEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

function encode(ev: SseEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

export interface SseStreamCallbacks {
  run: (emit: (ev: SseEvent) => Promise<void>) => Promise<void>;
}

/** Wrap a Hono context as an SSE stream. The `run` callback receives an
 *  `emit` function. Errors thrown inside `run` are converted to an error
 *  event so the client always gets a terminal signal. */
export function sse(c: Context, { run }: SseStreamCallbacks) {
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no"); // disable nginx buffering when proxied

  return stream(c, async (s) => {
    const emit = async (ev: SseEvent) => {
      await s.write(encode(ev));
    };
    try {
      await run(emit);
      await emit({ type: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit({ type: "error", message });
    }
  });
}
