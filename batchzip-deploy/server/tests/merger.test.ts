/**
 * Audio merger tests (local fixtures only — no external network):
 *  - merges strictly in numeric position order (proven by tone analysis)
 *  - skips files with no audio stream instead of failing the whole merge
 *  - throws on empty input
 *  - produces valid mp3 and wav outputs
 *  - end-to-end: a job created with mergeAudio yields one merged file
 *
 * All ffmpeg-dependent tests skip gracefully when no ffmpeg binary exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import {
  mergeAudios,
  ffmpegAvailable,
  type MergeInput,
} from "../src/engine/merger.js";
import { createJob, startJob } from "../src/engine/jobRunner.js";
import { loadJob, batchDir } from "../src/store.js";

const SAMPLE_RATE = 8000;

/** Write a real mono PCM16 WAV: a pure sine tone, easy to identify later. */
async function writeToneWav(
  dir: string,
  name: string,
  freqHz: number,
  seconds: number
): Promise<string> {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(
      16000 * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE)
    );
    data.writeInt16LE(s, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const p = path.join(dir, name);
  await fs.writeFile(p, Buffer.concat([header, data]));
  return p;
}

/** Goertzel magnitude at targetHz for PCM16 samples (mono). */
function goertzel(samples: Int16Array, targetHz: number): number {
  const k = Math.round((samples.length * targetHz) / SAMPLE_RATE);
  const omega = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0,
    s1 = 0,
    s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** First `seconds` of a PCM16 mono WAV as Int16Array (assumes 44-byte header). */
async function readWavHead(p: string, seconds: number): Promise<Int16Array> {
  const buf = await fs.readFile(p);
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2);
  return out;
}

function ffprobeDuration(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        p,
      ],
      { timeout: 15_000 },
      (err, stdout) =>
        err ? reject(err) : resolve(parseFloat(String(stdout).trim()))
    );
  });
}

let tmp = "";

// ffmpeg-dependent tests skip gracefully when no binary exists (top-level
// await is supported by vitest's ESM loader).
const itFfmpeg = (await ffmpegAvailable().catch(() => false)) ? it : it.skip;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "merge-test-"));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("mergeAudios", () => {
  itFfmpeg("concatenates in numeric position order (not input order)", async () => {
    // Positions: 1 -> 660Hz/0.5s, 2 -> 880Hz/0.7s, 3 -> 440Hz/0.3s.
    // Deliberately pass inputs shuffled: [3, 1, 2].
    const f1 = await writeToneWav(tmp, "a.wav", 660, 0.5);
    const f2 = await writeToneWav(tmp, "b.wav", 880, 0.7);
    const f3 = await writeToneWav(tmp, "c.wav", 440, 0.3);
    const inputs: MergeInput[] = [
      { position: 3, path: f3 },
      { position: 1, path: f1 },
      { position: 2, path: f2 },
    ];
    const out = path.join(tmp, "merged.wav");
    const res = await mergeAudios(inputs, "wav", out);
    expect(res.merged).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.bytes).toBeGreaterThan(0);

    // Total duration ~= 1.5s (ffmpeg may add a few ms of encoder padding).
    const dur = await ffprobeDuration(out);
    expect(dur).toBeGreaterThan(1.45);
    expect(dur).toBeLessThan(1.6);

    // The FIRST 0.4s must be position 1's 660Hz tone, not position 3's 440Hz.
    const head = await readWavHead(out, 0.4);
    const m660 = goertzel(head, 660);
    const m440 = goertzel(head, 440);
    const m880 = goertzel(head, 880);
    expect(m660).toBeGreaterThan(m440 * 4);
    expect(m660).toBeGreaterThan(m880 * 4);
  });

  itFfmpeg("skips files with no audio stream and merges the rest", async () => {
    const f1 = await writeToneWav(tmp, "s1.wav", 660, 0.4);
    const notAudio = path.join(tmp, "note.txt");
    await fs.writeFile(notAudio, "this is not audio");
    const f2 = await writeToneWav(tmp, "s2.wav", 880, 0.4);
    const out = path.join(tmp, "merged2.wav");
    const res = await mergeAudios(
      [
        { position: 1, path: f1 },
        { position: 2, path: notAudio },
        { position: 3, path: f2 },
      ],
      "wav",
      out
    );
    expect(res.merged).toBe(2);
    expect(res.skipped).toBe(1);
    const dur = await ffprobeDuration(out);
    expect(dur).toBeGreaterThan(0.75);
    expect(dur).toBeLessThan(0.9);
  });

  itFfmpeg("produces a valid mp3 output", async () => {
    const f1 = await writeToneWav(tmp, "m1.wav", 660, 0.4);
    const f2 = await writeToneWav(tmp, "m2.wav", 880, 0.4);
    const out = path.join(tmp, "merged.mp3");
    const res = await mergeAudios(
      [
        { position: 1, path: f1 },
        { position: 2, path: f2 },
      ],
      "mp3",
      out
    );
    expect(res.bytes).toBeGreaterThan(1000);
    const dur = await ffprobeDuration(out);
    expect(dur).toBeGreaterThan(0.7);
    expect(dur).toBeLessThan(1.0);
  });

  itFfmpeg("throws on empty input", async () => {
    await expect(
      mergeAudios([], "mp3", path.join(tmp, "empty.mp3"))
    ).rejects.toThrow(/no audio files/i);
  });
});

describe("jobRunner mergeAudio integration", () => {
  itFfmpeg("a mergeAudio job yields one merged file in position order", async () => {
    // Serve three real WAVs over loopback (different tones, 0.4s each).
    const f1 = await writeToneWav(tmp, "v1.wav", 660, 0.4);
    const f2 = await writeToneWav(tmp, "v2.wav", 880, 0.4);
    const f3 = await writeToneWav(tmp, "v3.wav", 440, 0.4);
    const files: Record<string, string> = {
      "/v1.wav": f1,
      "/v2.wav": f2,
      "/v3.wav": f3,
    };
    let server: Server | null = null;
    try {
      server = createServer(async (req, res) => {
        const p = files[req.url ?? ""];
        if (!p) {
          res.writeHead(404);
          res.end();
          return;
        }
        const data = await fs.readFile(p);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": data.length,
        });
        res.end(data);
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", () => resolve())
      );
      const addr = server.address();
      const port =
        typeof addr === "object" && addr ? addr.port : 0;
      const urls = [1, 2, 3].map(
        (i) => `http://127.0.0.1:${port}/v${i}.wav`
      );

      const job = await createJob("merge-e2e", urls, {
        mergeAudio: true,
        mergeFormat: "wav",
      });
      expect(job.mergeAudio).toBe(true);
      expect(job.mergedName).toBe("batch-1-3-merged.wav");

      await startJob(job.id);
      const finished = (await loadJob(job.id))!;
      expect(finished.phase).toBe("completed");
      expect(finished.mergeError).toBeNull();
      expect(finished.mergedReady).toBe(true);
      expect(finished.mergedBytes).toBeGreaterThan(0);

      const mergedPath = path.join(batchDir(job.id), finished.mergedName!);
      const head = await readWavHead(mergedPath, 0.35);
      // Position 1 (660Hz) must come first.
      expect(goertzel(head, 660)).toBeGreaterThan(goertzel(head, 440) * 4);
    } finally {
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
