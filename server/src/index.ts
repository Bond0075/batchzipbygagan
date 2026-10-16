/**
 * BatchZip Downloader — server entry point.
 */
import express from "express";
import cors from "cors";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { config } from "./config.js";
import { initStore } from "./store.js";
import { router } from "./routes/jobs.js";
import { recoverInterruptedJobs } from "./engine/jobRunner.js";
import { startCleanupScheduler } from "./engine/cleanup.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Simple in-memory rate limiter (per IP, per window) ----
const hits = new Map<string, { count: number; resetAt: number }>();
app.use("/api/", (req, res, next) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + config.rateLimitWindowMs });
    next();
    return;
  }
  entry.count++;
  if (entry.count > config.rateLimitMax) {
    res.status(429).json({ error: "Rate limit exceeded; slow down and try again" });
    return;
  }
  next();
});

app.use("/api", router);

// ---- Serve the built React client in production ----
const clientDist = path.resolve(process.cwd(), "client-dist");
async function mountClient() {
  try {
    await fs.access(path.join(clientDist, "index.html"));
    app.use(express.static(clientDist));
    // SPA fallback (but never shadow /api).
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
    console.log(`[server] serving client from ${clientDist}`);
  } catch {
    console.log("[server] no client build found; API-only mode");
  }
}

async function main() {
  await initStore();
  const recovered = await recoverInterruptedJobs();
  if (recovered > 0) console.log(`[server] marked ${recovered} interrupted job(s) as cancelled`);
  startCleanupScheduler();
  await mountClient();

  // Bound to a fixed port for deployment; tests import { app } and bind
  // their own ephemeral port instead.
  const port = Number(process.env.PORT_OVERRIDE ?? config.port);
  app.listen(port, () => {
    console.log(`[server] BatchZip Downloader listening on :${port}`);
    console.log(
      `[server] limits: ${config.maxUrlsPerBatch} urls/batch, ` +
        `${config.maxFileSizeBytes} B/file, ${config.maxBatchBytes} B/batch, ` +
        `${config.retryCount} retries, ${config.maxConcurrentJobs} concurrent jobs`
    );
  });
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error("[server] fatal:", e);
    process.exit(1);
  });
}

export { app };
