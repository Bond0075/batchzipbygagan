/**
 * Local HTTP fixture server for tests.
 *
 * Serves small synthetic files with correct magic bytes, plus failure modes
 * (flaky, always-500, empty, truncated, HTML masquerade, slow). Tracks the
 * maximum concurrent in-flight requests so tests can prove the engine never
 * downloads two files at once.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export const MAGIC: Record<string, Buffer> = {
  wav: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.from("data-bytes-wav")]),
  mp3: Buffer.concat([Buffer.from("ID3"), Buffer.from("fake-mp3-payload")]),
  pdf: Buffer.from("%PDF-1.4 fake pdf content"),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pngdata")]),
  txt: Buffer.from("plain text content"),
  zip: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("zipdata")]),
};

export interface FixtureOptions {
  /** Artificial per-file delay in ms (makes parallelism measurable). */
  fileDelayMs?: number;
  /** Number of times /flaky should fail before succeeding. */
  flakyFailures?: number;
}

export interface FixtureServer {
  base: string;
  close: () => Promise<void>;
  maxActive: () => number;
  requestLog: () => string[];
  resetStats: () => void;
}

export async function startFixtureServer(opts: FixtureOptions = {}): Promise<FixtureServer> {
  const fileDelayMs = opts.fileDelayMs ?? 0;
  let flakyRemaining = opts.flakyFailures ?? 0;
  let active = 0;
  let maxActive = 0;
  const log: string[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    log.push(`${req.method} ${p}`);
    active++;
    maxActive = Math.max(maxActive, active);
    const done = () => {
      active--;
    };
    res.on("close", done);

    const send = (buf: Buffer, contentType = "application/octet-stream", extra: Record<string, string> = {}) => {
      const finish = () => {
        res.writeHead(200, { "Content-Type": contentType, "Content-Length": buf.length, ...extra });
        res.end(buf);
      };
      if (fileDelayMs > 0) setTimeout(finish, fileDelayMs);
      else finish();
    };

    if (p.startsWith("/files/")) {
      // /files/<n>.<ext>
      const m = p.match(/^\/files\/(\d+)\.([a-z0-9]+)$/);
      if (!m) {
        res.writeHead(404).end("nope");
        return;
      }
      const ext = m[2];
      const body = MAGIC[ext] ?? Buffer.from(`generic-${ext}`);
      send(body);
      return;
    }
    if (p === "/flaky") {
      if (flakyRemaining > 0) {
        flakyRemaining--;
        res.writeHead(500).end("boom");
        return;
      }
      send(MAGIC.png); // sniffable content; no extension in path by design
      return;
    }
    if (p === "/always500") {
      res.writeHead(500).end("always broken");
      return;
    }
    if (p === "/forbidden") {
      res.writeHead(403).end("denied");
      return;
    }
    if (p === "/notfound") {
      res.writeHead(404).end("missing");
      return;
    }
    if (p === "/empty") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "0" });
      res.end();
      return;
    }
    if (p === "/truncated") {
      // Declares 1000 bytes, sends 100, then kills the connection.
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1000" });
      res.write(Buffer.alloc(100, 0x41));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (p.startsWith("/html-as-wav")) {
      const html = Buffer.from("<!DOCTYPE html><html><body>error page</body></html>");
      send(html, "text/html");
      return;
    }
    if (p === "/slow") {
      setTimeout(() => send(MAGIC.png), 800); // sniffable; no extension in path by design
      return;
    }
    if (p === "/noext") {
      // No extension in path, no Content-Disposition → must sniff PNG.
      send(MAGIC.png);
      return;
    }
    if (p === "/cd-header") {
      // No extension in path, but Content-Disposition provides one.
      send(MAGIC.pdf, "application/pdf", { "Content-Disposition": 'attachment; filename="report-final.pdf"' });
      return;
    }
    res.writeHead(404).end("unknown fixture");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    maxActive: () => maxActive,
    requestLog: () => [...log],
    resetStats: () => {
      maxActive = 0;
      log.length = 0;
    },
  };
}
