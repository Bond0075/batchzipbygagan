/**
 * API integration tests: exercise the real HTTP routes end to end
 * (validation, job lifecycle, tokens, SSE, ZIP/report downloads, 409s).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import AdmZip from "adm-zip";
import { startFixtureServer, type FixtureServer } from "./fixtures.js";

let fx: FixtureServer;
let http: Server;
let base: string;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (file downloads) */
  }
  return { res, json, text };
}

beforeAll(async () => {
  fx = await startFixtureServer({ fileDelayMs: 30 });
  const { app } = await import("../src/index.js");
  const { initStore } = await import("../src/store.js");
  await initStore();
  http = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  await fx.close();
});

describe("API", () => {
  it("GET /api/health and /api/config", async () => {
    const h = await api("/api/health");
    expect(h.res.status).toBe(200);
    expect(h.json.ok).toBe(true);
    const c = await api("/api/config");
    expect(c.json.maxUrlsPerBatch).toBeGreaterThan(0);
    expect(c.json.retryCount).toBe(3);
  });

  it("POST /api/validate classifies URLs", async () => {
    const { res, json } = await api("/api/validate", {
      method: "POST",
      body: JSON.stringify({
        urls: [`${fx.base}/files/1.wav`, "ftp://x/y", `${fx.base}/noext`],
      }),
    });
    expect(res.status).toBe(200);
    expect(json.total).toBe(3);
    expect(json.invalid).toBe(1);
    expect(json.issues[0].valid).toBe(true);
    expect(json.issues[0].extension).toBe("wav");
    expect(json.issues[1].valid).toBe(false);
    // noext: no extension anywhere → warning surfaced
    expect(json.issues[2].extensionWarning).toMatch(/could not determine/i);
  });

  it("full job lifecycle via HTTP", async () => {
    const urls = [
      `${fx.base}/files/1.wav`,
      `${fx.base}/always500`,
      `${fx.base}/files/3.pdf`,
    ];

    // Create
    const created = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ urls, batchName: "api-e2e" }),
    });
    expect(created.res.status).toBe(201);
    const { job, token } = created.json;
    expect(job.total).toBe(3);
    expect(job.zipName).toBe("batch-1-3.zip");
    expect(typeof token).toBe("string");

    // Duplicate batch name → 409 with suggestion
    const dup = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ urls, batchName: "api-e2e" }),
    });
    expect(dup.res.status).toBe(409);
    expect(dup.json.code).toBe("BATCH_NAME_EXISTS");
    expect(dup.json.suggestion).toContain("api-e2e");

    // Start with bad token → 403
    const badStart = await api(`/api/jobs/${job.id}/start`, {
      method: "POST",
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(badStart.res.status).toBe(403);

    // Start for real
    const started = await api(`/api/jobs/${job.id}/start`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(started.res.status).toBe(200);

    // Double start → 409
    const again = await api(`/api/jobs/${job.id}/start`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(again.res.status).toBe(409);

    // Poll until terminal
    let state: any;
    for (let i = 0; i < 100; i++) {
      const s = await api(`/api/jobs/${job.id}`);
      state = s.json;
      if (["completed", "failed", "cancelled"].includes(state.job.phase)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(state.job.phase).toBe("completed");
    expect(state.job.succeeded).toBe(2);
    expect(state.job.failed).toBe(1);
    expect(state.items[0].filename).toBe("1.wav");
    expect(state.items[1].status).toBe("failed");
    expect(state.items[2].filename).toBe("3.pdf");

    // ZIP download requires token
    const noToken = await fetch(`${base}/api/jobs/${job.id}/zip`);
    expect(noToken.status).toBe(403);
    const zipRes = await fetch(`${base}/api/jobs/${job.id}/zip?token=${token}`);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("content-disposition")).toContain("batch-1-3.zip");
    const buf = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(buf);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toEqual(["1.wav", "3.pdf", "download-report.csv"]);

    // Report CSV (full batch report: every position with status)
    const rep = await fetch(`${base}/api/jobs/${job.id}/report?token=${token}`);
    expect(rep.status).toBe(200);
    const csv = await rep.text();
    expect(csv).toMatch(/^position,url,status,filename,bytes,retries,error$/m);
    expect(csv).toMatch(/^1,.*packaged,1\.wav/m);
    expect(csv).toMatch(/^2,.*failed,,0,3,/m);
  });

  it("cancel via HTTP stops a running job", async () => {
    const urls = Array.from({ length: 4 }, () => `${fx.base}/slow`);
    const created = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ urls, batchName: "api-cancel" }),
    });
    const { job, token } = created.json;
    await api(`/api/jobs/${job.id}/start`, { method: "POST", body: JSON.stringify({ token }) });
    await new Promise((r) => setTimeout(r, 1100)); // first file done, second in flight
    const cancelled = await api(`/api/jobs/${job.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(cancelled.res.status).toBe(200);

    let state: any;
    for (let i = 0; i < 50; i++) {
      const s = await api(`/api/jobs/${job.id}`);
      state = s.json;
      if (state.job.phase === "cancelled") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(state.job.phase).toBe("cancelled");
    expect(state.items[0].status).toBe("verified");
  });

  it("rejects blocked URLs at creation time", async () => {
    const { res, json } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        urls: ["http://169.254.169.254/latest/meta-data/"],
        batchName: "api-blocked",
      }),
    });
    expect(res.status).toBe(400);
    expect(json.code).toBe("URLS_REJECTED");
    expect(json.bad[0].position).toBe(1);
  });
});
