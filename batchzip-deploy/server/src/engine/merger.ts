/**
 * Audio merger — concatenates verified audio files in NUMERIC position order
 * (1, 2, …, 10 — never alphabetical) into a single merged audio file.
 *
 * Uses ffmpeg's concat filter with re-encoding, so mixed input codecs and
 * containers (mp3, wav, m4a, ogg, …) merge cleanly. Files without an audio
 * stream are skipped (probed with ffprobe); if none remain, merging fails
 * with a clear error instead of producing a broken file.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

export interface MergeInput {
  position: number; // 1-based, original pasted order
  path: string; // absolute path to the downloaded file
}

export type MergeFormat = "mp3" | "wav";

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000; // generous; large batches take a while

let ffmpegChecked: boolean | null = null;

/** Cached check: is an ffmpeg binary usable on this server? */
export async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegChecked !== null) return ffmpegChecked;
  ffmpegChecked = await new Promise<boolean>((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 10_000 }, (err) =>
      resolve(!err)
    );
  });
  return ffmpegChecked;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", ...args],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ");
          reject(
            new Error(
              `ffmpeg merge failed${detail ? `: ${detail}` : ""}`
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}

/** True when ffprobe finds at least one audio stream in the file. */
async function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { timeout: 30_000 },
      (err, stdout) => resolve(!err && String(stdout).trim().length > 0)
    );
  });
}

export async function mergeAudios(
  inputs: MergeInput[],
  format: MergeFormat,
  outPath: string
): Promise<{ bytes: number; merged: number; skipped: number }> {
  if (!(await ffmpegAvailable())) {
    throw new Error(
      "ffmpeg is not installed on the server — audio merge needs ffmpeg"
    );
  }
  // Numeric position order, exactly like the ZIP builder.
  const ordered = [...inputs].sort((a, b) => a.position - b.position);
  if (ordered.length === 0) {
    throw new Error("No audio files to merge");
  }

  // Skip anything that isn't actually audio (e.g. a mislabeled download).
  const withAudio: MergeInput[] = [];
  let skipped = 0;
  for (const f of ordered) {
    if (await hasAudioStream(f.path)) withAudio.push(f);
    else skipped++;
  }
  if (withAudio.length === 0) {
    throw new Error(
      "None of the downloaded files contain an audio stream — nothing to merge"
    );
  }

  const args: string[] = [];
  for (const f of withAudio) args.push("-i", f.path);
  const filter =
    withAudio.map((_, i) => `[${i}:a]`).join("") +
    `concat=n=${withAudio.length}:v=0:a=1[out]`;
  args.push("-filter_complex", filter, "-map", "[out]", "-vn");
  if (format === "mp3") {
    args.push("-c:a", "libmp3lame", "-b:a", "192k");
  } else {
    args.push("-c:a", "pcm_s16le");
  }
  args.push("-y", outPath);

  await runFfmpeg(args);
  const stat = await fs.stat(outPath);
  if (stat.size === 0) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    throw new Error("ffmpeg produced an empty merged file");
  }
  return { bytes: stat.size, merged: withAudio.length, skipped };
}
