import { describe, expect, it } from "vitest";
import { HttpError } from "../src/errors.ts";
import { Transport, type TransportOptions } from "../src/transport.ts";

type Reply = { status?: number; cookie?: string; headers?: Record<string, string> } | Error;

function transport(replies: Reply[], options: Partial<TransportOptions> = {}) {
  const seen: { url: string; cookie: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), cookie: new Headers(init?.headers).get("cookie") });
    const reply = replies.shift() ?? {};
    if (reply instanceof Error) throw reply;
    const headers = new Headers(reply.headers);
    if (reply.cookie) headers.append("set-cookie", `wienXtraopac=${reply.cookie}; path=/`);
    return new Response("<html></html>", { status: reply.status ?? 200, headers });
  };
  const t = new Transport({
    baseUrl: "https://opac.test/index.php",
    fetch,
    userAgent: "test",
    minIntervalMs: 0,
    timeoutMs: 1000,
    retries: 2,
    now: () => 0,
    ...options,
  });
  return { t, seen };
}

describe("Transport", () => {
  it("adds the location and sends the session cookie back", async () => {
    const { t, seen } = transport([{ cookie: "abc" }, {}]);
    await t.get({ sword: "catan" });
    await t.get({ media: "x" });
    expect(seen[0]?.url).toBe("https://opac.test/index.php?sword=catan&location=sb");
    expect(seen[0]?.cookie).toBe("lang=de");
    expect(seen[1]?.cookie).toBe("lang=de; wienXtraopac=abc");
  });

  it("encodes umlauts as UTF-8", async () => {
    const { t, seen } = transport([{}]);
    await t.get({ sword: "Flügelschlag" });
    expect(seen[0]?.url).toContain("sword=Fl%C3%BCgelschlag");
  });

  it("bumps the generation when the server replaces the session", async () => {
    const { t } = transport([{ cookie: "a" }, { cookie: "a" }, { cookie: "b" }]);
    await t.get({});
    const first = t.generation;
    await t.get({});
    expect(t.generation).toBe(first);
    await t.get({});
    expect(t.generation).toBe(first + 1);
  });

  it("drops the session after 20 minutes idle", async () => {
    let now = 0;
    const { t, seen } = transport([{ cookie: "a" }, {}], { now: () => now });
    await t.get({});
    now = 21 * 60_000;
    await t.get({});
    expect(seen[1]?.cookie).toBe("lang=de");
  });

  it("retries network errors and 503s, then succeeds", async () => {
    const { t, seen } = transport([new TypeError("socket"), { status: 503, headers: { "retry-after": "0" } }, {}]);
    await expect(t.get({})).resolves.toBe("<html></html>");
    expect(seen).toHaveLength(3);
  });

  it("gives up after the configured retries", async () => {
    const { t, seen } = transport([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await expect(t.get({})).rejects.toMatchObject({ code: "HTTP", status: 503 });
    expect(seen).toHaveLength(3);
  });

  it("does not retry client errors", async () => {
    const { t, seen } = transport([{ status: 404 }]);
    await expect(t.get({})).rejects.toBeInstanceOf(HttpError);
    expect(seen).toHaveLength(1);
  });
});
