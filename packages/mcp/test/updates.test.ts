import { describe, expect, it, vi } from "vitest";
import { isNewer, UpdateCheck } from "../src/updates.ts";

const release = (tag: string) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}` }));

function check(response: () => Promise<Response>, currentVersion = "0.4.0") {
  const fetch = vi.fn<typeof globalThis.fetch>(response);
  const updates = new UpdateCheck({ currentVersion, repository: "x/y", howToUpdate: "Get it:", fetch });
  return { updates, fetch };
}

/** Lets the background check settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("UpdateCheck", () => {
  it("announces a newer release once", async () => {
    const { updates, fetch } = check(async () => release("v0.5.0"));
    updates.start();
    updates.start();
    await settle();
    expect(await updates.takeNotice()).toBe(
      "Update available: spielebox-mcp 0.5.0 (installed: 0.4.0). Get it: https://github.com/x/y/releases/tag/v0.5.0",
    );
    expect(await updates.takeNotice()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.github.com/repos/x/y/releases/latest");
  });

  it("stays silent before starting, while pending, and for the same or an older version", async () => {
    const same = check(async () => release("v0.4.0")).updates;
    expect(await same.takeNotice()).toBeNull();
    same.start();
    await settle();
    expect(await same.takeNotice()).toBeNull();

    const pending = check(() => new Promise<Response>(() => {})).updates;
    pending.start();
    expect(await pending.takeNotice()).toBeNull();
  });

  it("stays silent on errors and unexpected responses", async () => {
    for (const response of [
      async () => Promise.reject(new TypeError("offline")),
      async () => new Response("rate limited", { status: 403 }),
      async () => new Response("{}"),
    ]) {
      const { updates } = check(response);
      updates.start();
      await settle();
      expect(await updates.takeNotice()).toBeNull();
    }
  });
});

describe("isNewer", () => {
  it.each([
    ["0.5.0", "0.4.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.10.0", "0.9.0", true],
    ["0.4.0", "0.4.0", false],
    ["0.3.9", "0.4.0", false],
    ["0.5.0-beta.1", "0.4.0", false],
  ])("%s newer than %s: %s", (candidate, current, expected) => {
    expect(isNewer(candidate, current)).toBe(expected);
  });
});
