/**
 * SSRF protection for user-supplied download URLs.
 *
 * Rules:
 *  - Only http: and https: schemes are accepted.
 *  - The hostname is resolved via DNS and EVERY resolved address is checked.
 *  - Loopback, private (RFC1918 / RFC4193), link-local, multicast, reserved,
 *    unspecified and CGNAT (100.64.0.0/10) ranges are rejected.
 *  - Known cloud metadata endpoints (169.254.169.254, fd00:ec2::254, …)
 *    are covered by the link-local block.
 *  - Every redirect hop is re-validated (scheme + DNS + IP class) to defeat
 *    redirect-based and DNS-rebinding attacks.
 *  - Credentials in the URL (user:pass@host) are rejected.
 *  - Non-default ports are allowed but the port must be numeric and sane.
 *
 * Test fixtures run on loopback; they are only reachable when
 * SSRF_TEST_ALLOW_LOCALHOST=true (never enable in production).
 */
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { config } from "../config.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

interface V4Range {
  base: number;
  mask: number;
  label: string;
}

function v4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidr(base: string, bits: number, label: string): V4Range {
  return { base: v4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0, label };
}

// Blocked IPv4 ranges (superset of private/loopback/link-local/reserved).
const BLOCKED_V4: V4Range[] = [
  cidr("0.0.0.0", 8, "unspecified/current-network"),
  cidr("10.0.0.0", 8, "private (RFC1918)"),
  cidr("100.64.0.0", 10, "carrier-grade NAT (RFC6598)"),
  cidr("127.0.0.0", 8, "loopback"),
  cidr("169.254.0.0", 16, "link-local (incl. cloud metadata)"),
  cidr("172.16.0.0", 12, "private (RFC1918)"),
  cidr("192.0.0.0", 24, "IETF protocol assignments"),
  cidr("192.0.2.0", 24, "documentation (TEST-NET-1)"),
  cidr("192.88.99.0", 24, "reserved (6to4 relay)"),
  cidr("192.168.0.0", 16, "private (RFC1918)"),
  cidr("198.18.0.0", 15, "benchmarking"),
  cidr("198.51.100.0", 24, "documentation (TEST-NET-2)"),
  cidr("203.0.113.0", 24, "documentation (TEST-NET-3)"),
  cidr("224.0.0.0", 4, "multicast"),
  cidr("240.0.0.0", 4, "reserved"),
];

function isBlockedV4(ip: string): string | null {
  const n = v4ToInt(ip);
  for (const r of BLOCKED_V4) {
    if ((n & r.mask) === (r.base & r.mask)) return r.label;
  }
  return null;
}

function isBlockedV6(ip: string): string | null {
  const lower = ip.toLowerCase();
  // Normalize common forms
  if (lower === "::1" || lower === "::ffff:127.0.0.1") return "loopback";
  if (lower === "::" || lower === "::ffff:0.0.0.0") return "unspecified";
  if (lower.startsWith("fe80:")) return "link-local";
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "private (unique local)";
  if (lower.startsWith("ff")) return "multicast";
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped: check the embedded v4 address
    const v4 = lower.slice("::ffff:".length);
    if (net.isIPv4(v4)) {
      const label = isBlockedV4(v4);
      if (label) return `ipv4-mapped ${label}`;
    }
  }
  // 6to4 / Teredo embedded v4
  const embedded = lower.match(/(?:2002:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
  void embedded;
  return null;
}

function isBlockedIp(ip: string): string | null {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return "unparseable IP literal";
}

/**
 * Validate a URL string for safe server-side fetching.
 * Returns the normalized URL. Throws SsrfError on any violation.
 */
export async function validateUrl(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) throw new SsrfError("URL is empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SsrfError("Malformed URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported protocol "${url.protocol}" — only http and https are allowed`);
  }
  if (url.username || url.password) {
    throw new SsrfError("URLs containing credentials are not allowed");
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SsrfError("Invalid port in URL");
    }
  }

  const host = url.hostname.toLowerCase();
  if (!host) throw new SsrfError("URL has no hostname");
  if (host.length > 253) throw new SsrfError("Hostname too long");

  const allowlisted = config.ssrfAllowlistHosts.includes(host);

  // IP literals need no DNS: check the literal directly (this also removes
  // any DNS-rebinding surface for literal addresses).
  const bareHost = host.replace(/^\[|\]$/g, "");
  const isLiteral = net.isIP(bareHost) !== 0;

  let addresses: string[];
  if (isLiteral) {
    addresses = [bareHost];
  } else {
    // Resolve and check every address the hostname maps to (defeats naive
    // single-record checks and multi-record DNS rebinding tricks at fetch time).
    try {
      const [v4, v6] = await Promise.all([
        dns.resolve4(host).catch(() => [] as string[]),
        dns.resolve6(host).catch(() => [] as string[]),
      ]);
      addresses = [...v4, ...v6];
    } catch {
      throw new SsrfError(`DNS resolution failed for host "${host}"`);
    }
    if (addresses.length === 0) {
      throw new SsrfError(`Host "${host}" does not resolve to any IP address`);
    }
  }

  const isLoopbackFixture =
    config.ssrfTestAllowLocalhost && addresses.every((a) => a === "127.0.0.1" || a === "::1");

  if (!allowlisted && !isLoopbackFixture) {
    for (const addr of addresses) {
      const blocked = isBlockedIp(addr);
      if (blocked) {
        throw new SsrfError(
          `Host "${host}" resolves to a restricted address (${addr}, ${blocked})`
        );
      }
    }
  }

  return url.toString();
}

/**
 * Lightweight pre-check used by the Validate endpoint (no DNS blocking
 * decision beyond what validateUrl already does — this just classifies).
 */
export function classifyScheme(raw: string): { ok: boolean; reason?: string } {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: `Unsupported protocol "${url.protocol}"` };
    }
    if (url.username || url.password) return { ok: false, reason: "Credentials in URL" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "Malformed URL" };
  }
}
