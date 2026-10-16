# Test Report — BatchZip Downloader

**Date:** 2026-10-16 · **Runner:** vitest · **Result: 39/39 passing**

All tests run against a **local fixture HTTP server** (`tests/fixtures.ts`) — no external websites, fully deterministic. `SSRF_TEST_ALLOW_LOCALHOST=true` is set only for the test run so fixtures on `127.0.0.1` are reachable (production must never enable it).

## Coverage by requirement

| Requirement | Test | File |
|---|---|---|
| Exact preservation of pasted order | positions 1–5 map to input order; filenames `<pos>.<ext>` | `engine.test.ts` |
| Sequential execution, no overlap | fixture tracks in-flight requests → `maxActive() === 1`; wall time ≥ serial delays | `engine.test.ts` |
| Correct position-based numbering | `1.wav … 5.txt` from mixed extensions | `engine.test.ts` |
| Extension preservation (varied) | wav/mp3/pdf/png/txt round-trip | `engine.test.ts` |
| Extension priority (CD > path > sniff) | Content-Disposition beats URL path; sniffing fallback; warning when unknown | `extension.test.ts` |
| Retry behavior | `/flaky` fails 2× then succeeds → attempts=3, retries=2, errorHistory length 2 | `engine.test.ts` |
| Permanent failure w/o skipping | `/always500` (4 attempts) then positions 3,5 still processed; no renumbering | `engine.test.ts` |
| Zero-byte rejection | `/empty` → failed, "zero-byte" | `engine.test.ts` |
| Truncated transfer detection | Content-Length 1000, connection killed at 100 → failed "truncated" | `engine.test.ts` |
| HTML masquerade rejection | HTML body at `/…/audio.wav` → failed "HTML page instead of .wav" | `engine.test.ts` |
| Numeric ZIP order (30 files) | entries exactly `1.wav…30.txt` numeric; spot-check 10 after 9 | `engine.test.ts` |
| Failure report in ZIP | `download-report.csv` with position,url,retries,error for failed only, placed after numbered files | `engine.test.ts` |
| Full batch report (endpoint) | `batch-report-<id>.csv` with every position, status, filename, bytes, retries, error | `engine.test.ts` |
| Batch-name overwrite protection | `findLiveJobByBatchName` detects live names (case-insensitive); API returns 409 + suggestion | `cancel-cleanup.test.ts` + routes |
| Cancellation | mid-run cancel → item 1 stays verified, items 2–5 cancelled, phase cancelled, no ZIP | `cancel-cleanup.test.ts` |
| ZIP generation failure | missing verified file → `createZip` rejects with clear error | `engine.test.ts` |
| URL validation + SSRF | ftp/file/gopher rejected; credentials rejected; 169.254.169.254, 10/8, 192.168/16, 172.16/12, fd00::/8 blocked; malformed rejected | `ssrf.test.ts` |
| Temp-file cleanup | expired jobs deleted, orphan batch dirs removed, stale tmp files purged | `cancel-cleanup.test.ts` |

## Not covered by automation (manual checklist)

- Real-world redirect chains with mixed public hosts (covered by code: every hop re-validated; needs internet to test live).
- Browser refresh mid-job → client resumes via localStorage jobId + SSE/polling (implemented; verify manually).
- Multi-GB files / disk-full behavior (limit logic implemented; `MIN_FREE_DISK_BYTES` guard; exercise on staging).
- Concurrent jobs from two users (limit enforced in `startJob`; engine isolation by job ID).

## Setup

```bash
cd server
npm install
npm test          # vitest run — ~10s, no network needed
npm run build     # tsc — must pass with zero errors
```
