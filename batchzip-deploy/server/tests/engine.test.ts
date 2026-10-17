/**
 * Core engine tests:
 *  - exact preservation of pasted order
 *  - strictly sequential execution (max 1 in-flight request per batch)
 *  - position-based numbering with preserved extensions
 *  - retry behavior (flaky then success)
 *  - permanent failure does NOT skip subsequent URLs
 *  - zero-byte rejection, truncation detection, HTML masquerade rejection
 *  - numeric ZIP entry ordering across 30 files + embedded failure report
 */
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { startFixtureServer } from "./fixtures.js";
import { createJob, startJob } from "../src/engine/jobRunner.js";
import { loadJob, zipPath } from "../src/store.js";

const EXTS = ["wav", "mp3", "pdf", "png", "txt"] as const;

describe("sequential engine", () => {
  it("processes URLs in exact input order, strictly one at a time", async () => {
    const fx = await startFixtureServer({ fileDelayMs: 120 });
    try {
      const urls = EXTS.map((e, i) => `${fx.base}/files/${i + 1}.${e}`);
      const job = await createJob("order-test", urls);

      const started = Date.now();
      await startJob(job.id);
      const elapsed = Date.now() - started;

      const finished = (await loadJob(job.id))!;
      expect(finished.phase).toBe("completed");
      // Order preserved: position i has extension EXTS[i], named "<pos>.<ext>".
      for (let i = 0; i < EXTS.length; i++) {
        const item = finished.items[i];
        expect(item.position).toBe(i + 1);
        expect(item.status).toBe("packaged");
        expect(item.filename).toBe(`${i + 1}.${EXTS[i]}`);
        expect(item.extension).toBe(EXTS[i]);
      }
      // Strictly sequential: never more than 1 in-flight request, and the
      // total time reflects serial 120ms delays (not parallel).
      expect(fx.maxActive()).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(EXTS.length * 120 * 0.85);

      // ZIP entries in numeric position order.
      const zip = new AdmZip(zipPath(job.id, finished.zipName!));
      const names = zip.getEntries().map((e) => e.entryName);
      expect(names).toEqual(EXTS.map((e, i) => `${i + 1}.${e}`));
    } finally {
      await fx.close();
    }
  });

  it("retries flaky downloads and records attempts", async () => {
    const fx = await startFixtureServer({ flakyFailures: 2 });
    try {
      const job = await createJob("retry-test", [`${fx.base}/flaky`]);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      const item = finished.items[0];
      expect(item.status).toBe("packaged");
      expect(item.attempts).toBe(3); // 1 initial + 2 retries
      expect(item.retries).toBe(2);
      expect(item.errorHistory).toHaveLength(2);
      expect(finished.phase).toBe("completed");
    } finally {
      await fx.close();
    }
  });

  it("marks permanent failures but continues with later positions (no renumbering)", async () => {
    const fx = await startFixtureServer({ fileDelayMs: 20 });
    try {
      const urls = [
        `${fx.base}/files/1.wav`,
        `${fx.base}/always500`, // position 2: permanent failure (4 attempts)
        `${fx.base}/files/3.pdf`,
        `${fx.base}/notfound`, // position 4: 404, not retryable
        `${fx.base}/files/5.mp3`,
      ];
      const job = await createJob("failure-test", urls);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;

      expect(finished.phase).toBe("completed"); // some succeeded
      const [a, b, c, d, e] = finished.items;
      expect(a.status).toBe("packaged");
      expect(b.status).toBe("failed");
      expect(b.attempts).toBe(4); // 1 initial + 3 retries
      expect(b.retries).toBe(3);
      expect(b.error).toMatch(/server error|500/i);
      expect(c.status).toBe("packaged");
      expect(c.filename).toBe("3.pdf"); // position preserved despite earlier failure
      expect(d.status).toBe("failed");
      expect(d.attempts).toBe(1); // 404 is not retryable
      expect(e.status).toBe("packaged");
      expect(e.filename).toBe("5.mp3");
      expect(finished.succeeded).toBe(3);
      expect(finished.failed).toBe(2);

      // Failure report embedded in the ZIP, AFTER the numbered files.
      const zip = new AdmZip(zipPath(job.id, finished.zipName!));
      const names = zip.getEntries().map((en) => en.entryName);
      expect(names).toEqual(["1.wav", "3.pdf", "5.mp3", "download-report.csv"]);
      const csv = zip.readAsText("download-report.csv");
      expect(csv).toMatch(/^position,url,retries,error$/m);
      expect(csv).toContain("2,");
      expect(csv).toContain("4,");
    } finally {
      await fx.close();
    }
  });

  it("rejects zero-byte files", async () => {
    const fx = await startFixtureServer();
    try {
      const job = await createJob("empty-test", [`${fx.base}/empty`]);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      expect(finished.items[0].status).toBe("failed");
      expect(finished.items[0].error).toMatch(/zero-byte|empty|0 bytes/i);
      expect(finished.phase).toBe("failed");
      expect(finished.zipReady).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("detects truncated transfers", async () => {
    const fx = await startFixtureServer();
    try {
      const job = await createJob("trunc-test", [`${fx.base}/truncated`]);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      expect(finished.items[0].status).toBe("failed");
      expect(finished.items[0].error).toMatch(/truncat|incomplete/i);
    } finally {
      await fx.close();
    }
  });

  it("rejects HTML error pages masquerading as downloads", async () => {
    const fx = await startFixtureServer();
    try {
      // URL path says .wav, server returns an HTML error page.
      const job = await createJob("html-test", [`${fx.base}/html-as-wav/audio.wav`]);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      expect(finished.items[0].status).toBe("failed");
      expect(finished.items[0].error).toMatch(/html page/i);
    } finally {
      await fx.close();
    }
  });

  it("sniffs extension when path and headers give none", async () => {
    const fx = await startFixtureServer();
    try {
      const job = await createJob("sniff-test", [`${fx.base}/noext`]);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      const item = finished.items[0];
      expect(item.status).toBe("packaged");
      expect(item.extension).toBe("png");
      expect(item.extensionSource).toBe("content-sniff");
      expect(item.filename).toBe("1.png");
    } finally {
      await fx.close();
    }
  });

  it("uses Content-Disposition filename extension with highest priority", async () => {
    const fx = await startFixtureServer();
    try {
      const job = await createJob("cd-test", [`${fx.base}/cd-header`]);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      const item = finished.items[0];
      expect(item.extension).toBe("pdf");
      expect(item.extensionSource).toBe("content-disposition");
      expect(item.filename).toBe("1.pdf");
    } finally {
      await fx.close();
    }
  });
});

describe("numeric ZIP ordering at scale", () => {
  it("orders 30 entries numerically (1..30), not alphabetically", async () => {
    const fx = await startFixtureServer();
    try {
      const urls = Array.from({ length: 30 }, (_, i) => {
        const ext = EXTS[i % EXTS.length];
        return `${fx.base}/files/${i + 1}.${ext}`;
      });
      const job = await createJob("zip30-test", urls);
      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      if (finished.phase !== "completed") {
        const bad = finished.items.filter((i) => i.status === "failed");
        console.log("DEBUG phase", finished.phase, "jobError", finished.error, "failed", bad.length,
          "first:", bad[0]?.error, JSON.stringify(bad[0]?.errorHistory));
      }
      expect(finished.phase).toBe("completed");
      expect(finished.zipName).toBe("batch-1-30.zip");

      const zip = new AdmZip(zipPath(job.id, finished.zipName!));
      const names = zip.getEntries().map((e) => e.entryName);
      const expected = Array.from({ length: 30 }, (_, i) => `${i + 1}.${EXTS[i % EXTS.length]}`);
      expect(names).toEqual(expected);
      // Spot check: entry 10 sorts after 9 (would fail under alphabetical order).
      expect(names.indexOf("10.txt")).toBeGreaterThan(names.indexOf("9.png"));
    } finally {
      await fx.close();
    }
  });
});

describe("zip generation failure", () => {  it("fails safely when a verified file is missing at packaging time", async () => {
    const { createZip } = await import("../src/engine/zipper.js");
    await expect(
      createZip({
        jobId: "nonexistent-job",
        zipName: "batch-1-1.zip",
        items: [
          {
            position: 1,
            url: "http://x",
            status: "verified",
            filename: "1.wav", // does not exist on disk
          } as any,
        ],
      })
    ).rejects.toThrow(/missing/i);
  });
});

describe("full batch report", () => {
  it("lists every position with status, in numeric order", async () => {
    const { buildFullReportCsv } = await import("../src/engine/zipper.js");
    const csv = buildFullReportCsv([
      { position: 2, url: "http://x/2.mp3", status: "packaged", filename: "2.mp3", bytes: 100, retries: 0, error: null } as any,
      { position: 1, url: "http://x/1.wav", status: "failed", filename: null, bytes: 0, retries: 3, error: "Not found" } as any,
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("position,url,status,filename,bytes,retries,error");
    expect(lines[1]).toMatch(/^1,http:\/\/x\/1\.wav,failed,,0,3,Not found$/);
    expect(lines[2]).toMatch(/^2,http:\/\/x\/2\.mp3,packaged,2\.mp3,100,0,$/);
  });
});
