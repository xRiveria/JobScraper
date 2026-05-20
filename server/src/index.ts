import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { jobsRoute } from "./routes/jobs.js";
import { aiRoute } from "./routes/ai.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin ?? "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type"],
  }),
);

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api/jobs", jobsRoute);
app.route("/api/ai", aiRoute);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`→ server listening on http://localhost:${port}`);
});
