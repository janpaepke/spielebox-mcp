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
  it("serves the plan with a nonce-bound script and escaped content, without personal data", async () => {
    pages = new HandoffPages();
    const url = await pages.create({
      purpose: "order",
      titles: ["CATAN Connect", "<img src=x onerror=alert(1)>"],
      steps: STEPS,
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
    expect(html).not.toContain("data-copy");
    expect(html).toContain(JSON.stringify(STEPS[2]?.url));
    expect(html).toContain("Merkliste füllen und Bestellformular öffnen");
    // The cache-busting regex must reach the browser intact.
    expect(html).toContain("/([?&]deletebasket=)\\d+/");
  });

  it("keeps values from closing the script tag", async () => {
    pages = new HandoffPages();
    const url = await pages.create({
      purpose: "order",
      titles: ["x"],
      steps: [{ kind: "form", url: "https://opac.wienxtra.at/index.php?x=</script><script>alert(1)</script>" }],
    });
    const html = await (await fetch(url)).text();
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("serves a game page with its own texts and steps", async () => {
    pages = new HandoffPages();
    const url = await pages.create({
      purpose: "game",
      title: "CATAN <Connect>",
      steps: [
        { kind: "search", url: "https://opac.wienxtra.at/index.php?newsearch=true&sword=catan&location=sb" },
        { kind: "detail", url: "https://opac.wienxtra.at/index.php?media=x&location=sb" },
      ],
    });
    const html = await (await fetch(url)).text();
    expect(html).toContain("<h1>CATAN &lt;Connect&gt;</h1>");
    expect(html).toContain("Detailseite öffnen");
    expect(html.split("<script")[0]).not.toContain("Merkliste");
    expect(html).toContain('"tab":"spielebox-katalog"');
  });

  it("answers unknown, expired and non-GET requests without the plan", async () => {
    let now = 0;
    pages = new HandoffPages({ ttlMs: 1000, now: () => now });
    const url = await pages.create({ purpose: "order", titles: ["x"], steps: STEPS });
    expect((await fetch(`${url.slice(0, -4)}AAAA`)).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    now = 2000;
    expect((await fetch(url)).status).toBe(404);
  });
});
