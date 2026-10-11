import { afterEach, describe, expect, it } from "vitest";
import { HandoffPages } from "../src/handoff/pages.ts";

const STEPS = [
  { kind: "clear" as const, url: "https://opac.wienxtra.at/index.php?deletebasket=1&location=sb" },
  { kind: "search" as const, url: "https://opac.wienxtra.at/index.php?newsearch=true&sword=catan&location=sb" },
  { kind: "add" as const, url: "https://opac.wienxtra.at/index.php?basket=add&media=x&location=sb" },
  { kind: "form" as const, url: "https://opac.wienxtra.at/index.php?orderbasket=true&location=sb" },
];

let pages: HandoffPages;
afterEach(() => pages?.close());

describe("HandoffPages", () => {
  it("serves the plan with a nonce-bound script, escaped content and copyable contact data", async () => {
    pages = new HandoffPages();
    const url = await pages.create({
      titles: ["CATAN Connect", "<img src=x onerror=alert(1)>"],
      steps: STEPS,
      contact: { firstName: "Erika", email: "erika@example.org" },
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/h\/[\w-]{32}$/);
    const res = await fetch(url);
    const html = await res.text();
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('data-copy="Erika"');
    expect(html).toContain('data-copy="erika@example.org"');
    expect(html).toContain(JSON.stringify(STEPS[2]?.url));
    expect(html).toContain("Merkliste füllen und Bestellformular öffnen");
  });

  it("keeps values from closing the script tag", async () => {
    pages = new HandoffPages();
    const url = await pages.create({
      titles: ["x"],
      steps: [{ kind: "form", url: "https://opac.wienxtra.at/index.php?x=</script><script>alert(1)</script>" }],
      contact: {},
    });
    const html = await (await fetch(url)).text();
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("Hinterlege Name und E-Mail");
  });

  it("answers unknown, expired and non-GET requests without the plan", async () => {
    let now = 0;
    pages = new HandoffPages({ ttlMs: 1000, now: () => now });
    const url = await pages.create({ titles: ["x"], steps: STEPS, contact: {} });
    expect((await fetch(`${url.slice(0, -4)}AAAA`)).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    now = 2000;
    expect((await fetch(url)).status).toBe(404);
  });
});
