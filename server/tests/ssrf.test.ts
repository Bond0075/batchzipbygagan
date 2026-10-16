/**
 * SSRF protection tests: blocked destinations, unsupported schemes,
 * credentials, and redirect re-validation.
 */
import { describe, it, expect } from "vitest";
import { validateUrl, SsrfError } from "../src/security/ssrf.js";

describe("SSRF protection", () => {
  it("rejects unsupported schemes", async () => {
    await expect(validateUrl("ftp://example.com/file.zip")).rejects.toThrow(SsrfError);
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(SsrfError);
    await expect(validateUrl("gopher://example.com/")).rejects.toThrow(SsrfError);
  });

  it("rejects credentials in the URL", async () => {
    await expect(validateUrl("https://user:pass@example.com/f")).rejects.toThrow(/credentials/i);
  });

  it("rejects malformed URLs", async () => {
    await expect(validateUrl("not a url")).rejects.toThrow(SsrfError);
    await expect(validateUrl("")).rejects.toThrow(SsrfError);
  });

  it("blocks cloud metadata / link-local endpoints", async () => {
    // 169.254.169.254 is the classic cloud metadata IP.
    await expect(validateUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /restricted|link-local/i
    );
  });

  it("blocks private RFC1918 ranges", async () => {
    await expect(validateUrl("http://10.0.0.5/file")).rejects.toThrow(/restricted|private/i);
    await expect(validateUrl("http://192.168.1.1/file")).rejects.toThrow(/restricted|private/i);
    await expect(validateUrl("http://172.16.5.4/file")).rejects.toThrow(/restricted|private/i);
  });

  it("blocks IPv6 unique-local (loopback allowed only under the test flag)", async () => {
    await expect(validateUrl("http://[fd00::1]/file")).rejects.toThrow(/restricted|private/i);
    // ::1 is loopback: allowed only because SSRF_TEST_ALLOW_LOCALHOST=true in tests.
    await expect(validateUrl("http://[::1]/file")).resolves.toContain("[::1]");
  });

  it("allows loopback fixtures when SSRF_TEST_ALLOW_LOCALHOST=true", async () => {
    // The test env sets this flag so fixture servers on 127.0.0.1 work.
    const normalized = await validateUrl("http://127.0.0.1:1234/files/1.wav");
    expect(normalized).toContain("127.0.0.1");
  });
});
