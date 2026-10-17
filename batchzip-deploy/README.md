# BatchZip Downloader

Paste a list of direct-download URLs → the server downloads them **strictly one at a time, in your exact order** → verifies each file → retries failures → packages everything into a numbered ZIP (`batch-1-N.zip`).

```
https://example.com/audio-a.wav
https://example.com/audio-b.wav
https://example.com/document.pdf
```
becomes `1.wav`, `2.wav`, `3.pdf` inside the ZIP — always in numeric position order.

**🎙️ Audio merge mode:** tick *“🔗 Audios ko merge karke ek file banao”* before starting —
every audio downloads in sequence, then ffmpeg concatenates them in 1, 2, 3… order
into a single file (`batch-1-N-merged.mp3`, or WAV if you choose). One download,
one voice.

## Architecture

```
┌─────────────┐      ┌──────────────────────────────────────┐
│ React + TS  │      │ Node.js + Express (TypeScript)        │
│ dashboard   │◄────►│  • strictly sequential download loop  │
│ (SSE live   │ /api │  • SSRF guard (DNS + IP re-validation│
│  progress)  │      │    on every redirect hop)             │
└─────────────┘      │  • retry w/ exponential backoff       │
                     │  • verification (size, truncation,    │
                     │    HTML-masquerade, magic bytes)      │
                     │  • ZIP streaming (bounded memory)     │
                     │  • JSON job store + retention cleanup │
                     └──────────────────────────────────────┘
```

**Why a backend, not browser-only:** browsers can't reliably fetch arbitrary URLs (CORS), can't verify/trust downloads, can't survive tab closes, and can't generate multi-GB ZIPs without blowing up memory. The server streams everything to disk.

**No database required.** Job state is persisted as JSON files (`DATA_DIR/jobs/*.json`) with atomic writes, so a restart recovers safely (interrupted jobs are marked cancelled, never resumed half-way — resumable downloads are *not* claimed). If you outgrow single-node, swap `src/store.ts` for a DB-backed implementation.

## Quick start

### Local development

```bash
# Terminal 1 — backend
cd server
npm install
npm run dev        # http://localhost:3001 (API only)

# Terminal 2 — frontend
cd client
npm install
npm run dev        # http://localhost:5173 (proxies /api → :3001)
```

### Production (single command)

```bash
cd client && npm install && npm run build   # → server/client-dist
cd ../server && npm install && npm run build && npm start
```

Or with Docker:

```bash
cp server/.env.example server/.env   # adjust limits
docker compose up --build -d
# → http://localhost:3001
```

## Configuration

All settings are environment variables — see `server/.env.example` for the full list. Conservative defaults:

| Setting | Default | Notes |
|---|---|---|
| `MAX_URLS_PER_BATCH` | 50 | |
| `MAX_FILE_SIZE_BYTES` | 512 MiB | per file |
| `MAX_BATCH_BYTES` | 5 GiB | whole batch |
| `REQUEST_TIMEOUT_MS` | 60 s | per attempt |
| `RETRY_COUNT` | 3 | retries *after* the initial attempt |
| `MAX_CONCURRENT_JOBS` | 4 | across users; within a batch always sequential |
| `BATCH_RETENTION_HOURS` | 24 | auto-cleanup of files + ZIPs |
| `MIN_FREE_DISK_BYTES` | 1 GiB | new jobs refused below this |

**Raising limits safely:** disk needed ≈ `MAX_BATCH_BYTES × MAX_CONCURRENT_JOBS` plus headroom for temp files and ZIPs. Memory stays low (streaming), but keep ≥1–2 GB RAM per concurrent job for large files. Increase `REQUEST_TIMEOUT_MS` for slow origins; `RETRY_BASE_DELAY_MS` controls backoff politeness.

## Deployment

This app needs **long-running processes** — plain serverless functions (Vercel/Netlify/AWS Lambda) are *not* suitable (execution caps, ephemeral disk, no SSE).

**Good options:**
- **Fly.io** — `fly launch` with the Dockerfile; add a volume mounted at `/data` (`DATA_DIR=/data`). One Machine with 2–4 GB RAM handles the defaults.
- **Render** — one-click: push the repo to GitHub, then render.com → **New → Blueprint** → connect the repo. The included `render.yaml` provisions everything (free plan; ephemeral storage is fine since users download the ZIP immediately). For always-on + persistent storage, use a paid plan and uncomment the disk block in `render.yaml`.
- **Any VPS (Hetzner/DigitalOcean)** — `docker compose up -d` with the compose file; put Caddy/Nginx in front for TLS.
- **Railway/Coolify** — Dockerfile deploy + volume at `/data`.

**Checklist:** TLS terminator in front · `DATA_DIR` on a volume with enough space · set `MAX_*` to match the disk · never set `SSRF_TEST_ALLOW_LOCALHOST=true` in production · keep `RATE_LIMIT_MAX` sensible · monitor disk usage (jobs auto-expire, but a burst of 5 GiB batches adds up).

## Security model

- **SSRF hardened:** http/https only, no credentials in URLs, every hostname's resolved IPs checked against loopback/private/link-local/multicast/reserved/CGNAT ranges, IP literals checked without DNS, **every redirect hop re-validated** (kills redirect + DNS-rebinding attacks), metadata endpoints (169.254.x.x) blocked.
- Per-job unguessable access tokens for start/cancel/ZIP/report/file endpoints.
- Per-IP rate limiting, 1 MB JSON body cap, filename sanitization (no path traversal), batch-name allowlist chars, batch directories isolated per job (unique ID, never shared).
- Automatic cleanup of temp files and expired jobs.
- The server never bypasses auth/DRM/anti-bot: it sends a plain documented User-Agent and honors 401/403/429 as failures.

## Limitations (honest)

- **No resumable downloads** — retries restart the file from byte 0. Large files on flaky origins may take several attempts.
- Downloads are **strictly sequential per batch** by design (your requirement) — a batch of 50 × 500 MB files takes a while; that's the tradeoff for order guarantees.
- Sites requiring login, CAPTCHAs, or JavaScript-rendered download buttons are not supported (no credentialed fetching).
- Extension detection needs *some* signal (Content-Disposition, URL path, or recognizable magic bytes); truly opaque streams are flagged for your decision before the job starts.
- ZIP uses DEFLATE level 6; already-compressed media won't shrink much.
- Single-node: horizontal scaling needs a shared store (see Architecture).

## Operating costs (rough)

- **Compute:** trivial CPU; ~50–200 MB RAM typical. A $5–10/mo VPS or Fly Machine covers moderate use.
- **Bandwidth:** the dominant cost — you pay egress twice (origin→server, server→user). 100 GB/mo of batches ≈ $1–9 depending on provider.
- **Disk:** transient; sized by `MAX_BATCH_BYTES × MAX_CONCURRENT_JOBS`. 25–50 GB volume is comfortable for defaults.

## Testing

```bash
cd server && npm test   # 39 tests, all local fixtures — no external network
```

Covers: order preservation, strict sequentiality (max 1 in-flight), position numbering, extension priority + sniffing, retry counting, failure continuation without renumbering, zero-byte rejection, truncation detection, HTML-masquerade rejection, 30-file numeric ZIP ordering, embedded failure CSV, batch-name protection, cancellation semantics, ZIP failure handling, SSRF blocks, cleanup. See `TESTING.md` for the full report.

## API

See `API_CONTRACT.md`. Highlights: `POST /api/validate`, `POST /api/jobs`, `POST /api/jobs/:id/start`, `GET /api/jobs/:id/events` (SSE), `POST /api/jobs/:id/cancel`, `GET /api/jobs/:id/zip?token=…`.

## Project layout

```
batchzip/
├── client/            # React + TS + Tailwind dashboard
├── server/
│   ├── src/
│   │   ├── index.ts        # Express app, rate limiting, boot recovery
│   │   ├── config.ts       # env-driven limits
│   │   ├── store.ts        # JSON job persistence
│   │   ├── security/ssrf.ts
│   │   ├── engine/
│   │   │   ├── jobRunner.ts  # THE sequential loop (for + await, no Promise.all)
│   │   │   ├── downloader.ts # per-file download, retry, verification
│   │   │   ├── http.ts       # redirect re-validation, timeouts
│   │   │   ├── zipper.ts     # numeric-order ZIP + failure CSV
│   │   │   └── cleanup.ts    # retention sweeper
│   │   ├── routes/jobs.ts
│   │   └── utils/extension.ts
│   └── tests/           # vitest suite (39 tests)
├── API_CONTRACT.md
├── TESTING.md
├── Dockerfile
└── docker-compose.yml
```
