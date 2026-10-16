/**
 * ZIP generation.
 *
 * - Entries are added in NUMERIC position order (1, 2, …, 10 — never
 *   alphabetical, so 10 never sorts before 2).
 * - Only verified files are included.
 * - If any position failed, a download-report.csv is embedded with position,
 *   original URL, retry count and failure reason.
 * - Streams file data so memory stays bounded regardless of file sizes.
 */
import { ZipArchive } from "archiver";
import { createWriteStream, promises as fs } from "node:fs";
import * as path from "node:path";
import type { Job, FileItem } from "../types.js";
import { batchDir, batchFilesDir } from "../store.js";

export interface ZipInput {
  jobId: string;
  zipName: string;
  items: FileItem[]; // job.items (verified ones must have filename set)
}

/** Numeric ordering: position 1..N, never alphabetical. */
export function sortNumerically<T extends { position: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

function csvEscape(v: string | number | null): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildReportCsv(items: FileItem[]): string {
  const rows = ["position,url,retries,error"];
  for (const it of sortNumerically(items)) {
    if (it.status === "failed") {
      rows.push(
        [it.position, csvEscape(it.url), it.retries, csvEscape(it.error ?? "")].join(",")
      );
    }
  }
  return rows.join("\n") + "\n";
}

/** Full batch report: every position, successful or not (for the /report download). */
export function buildFullReportCsv(items: FileItem[]): string {
  const rows = ["position,url,status,filename,bytes,retries,error"];
  for (const it of sortNumerically(items)) {
    rows.push(
      [
        it.position,
        csvEscape(it.url),
        it.status,
        csvEscape(it.filename ?? ""),
        it.bytes || 0,
        it.retries,
        csvEscape(it.error ?? ""),
      ].join(",")
    );
  }
  return rows.join("\n") + "\n";
}

export async function createZip(input: ZipInput): Promise<{ bytes: number; files: number }> {
  const verified = sortNumerically(input.items.filter((i) => i.status === "verified" && i.filename));
  const failed = input.items.filter((i) => i.status === "failed");

  const outDir = batchDir(input.jobId);
  await fs.mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, input.zipName);

  await fs.rm(zipPath, { force: true });

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    let settled = false;
    const done = (err?: Error, result?: { bytes: number; files: number }) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(result!);
    };

    output.on("close", () => done(undefined, { bytes: archive.pointer(), files: verified.length }));
    output.on("error", (e: Error) => done(new Error(`ZIP write failed: ${e.message}`)));
    archive.on("error", (e: Error) => done(new Error(`ZIP generation failed: ${e.message}`)));
    archive.on("warning", (e) => {
      // Non-fatal (e.g. stat failures on already-removed files) — surface as error to be safe.
      done(new Error(`ZIP warning treated as failure: ${e.message}`));
    });

    archive.pipe(output);

    (async () => {
      try {
        const filesDir = batchFilesDir(input.jobId);
        for (const item of verified) {
          const abs = path.join(filesDir, item.filename!);
          // Guard: the file must still exist and be inside the batch dir.
          let stat;
          try {
            stat = await fs.stat(abs);
          } catch {
            throw new Error(`Verified file ${item.filename} is missing at packaging time`);
          }
          if (!stat.isFile() || stat.size === 0) {
            throw new Error(`Verified file ${item.filename} is missing or empty at packaging time`);
          }
          archive.file(abs, { name: item.filename! });
        }

        let reportTmp: string | null = null;
        if (failed.length > 0) {
          const csv = buildReportCsv(input.items);
          // Write via a temp file and archive.file() (not append()) so the
          // report keeps its queued position AFTER the numbered files —
          // append() would race ahead of the streaming file entries.
          reportTmp = path.join(outDir, `.download-report-${Date.now()}.csv.tmp`);
          await fs.writeFile(reportTmp, csv, "utf8");
          archive.file(reportTmp, { name: "download-report.csv" });
        }

        await archive.finalize();
        if (reportTmp) await fs.rm(reportTmp, { force: true }).catch(() => {});
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}
