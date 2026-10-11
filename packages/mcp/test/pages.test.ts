import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationPages } from "../src/consent/pages.ts";

const REQUEST = {
  ids: ["3375ddafbc45fed35c0da0b4cc481084"],
  titles: ["CATAN Connect", "<script>alert(1)</script>"],
  contact: { firstName: "Erika", email: "erika@example.org" },
};
const CONTACT = { firstName: "Erika", lastName: "Muster", email: "erika@example.org", phone: "+43 1 234" };

let pages: ConfirmationPages;
afterEach(() => pages?.close());

/** Submits the confirmation form like a browser on the page would. */
function submit(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { origin: new URL(url).origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
  });
}

describe("ConfirmationPages", () => {
  it("serves an escaped, prefilled page on 127.0.0.1 without personal data in the URL", async () => {
    pages = new ConfirmationPages();
    const { url } = await pages.open(REQUEST);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c\/[\w-]{32}$/);
    const res = await fetch(url);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("<li>CATAN Connect</li>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('value="Erika"');
    expect(html).toContain("Zusendung von Informationen über Angebote des Vereins wienXtra");
  });

  it("grants with the contact data entered on the page, once", async () => {
    pages = new ConfirmationPages();
    const { url, ticket } = await pages.open(REQUEST);
    const waiting = pages.waitFor(ticket, 5000);
    const res = await submit(url, { ...CONTACT, confirm: "yes", action: "confirm" });
    expect(res.status).toBe(200);
    expect(await waiting).toEqual({ granted: true, contact: CONTACT });
    const again = await submit(url, { ...CONTACT, confirm: "yes", action: "confirm", lastName: "Other" });
    expect(await again.text()).toContain("Bestätigt");
    expect(await pages.waitFor(ticket, 10)).toEqual({ granted: true, contact: CONTACT });
  });

  it("requires the confirmation box and valid contact data, and keeps the page open", async () => {
    pages = new ConfirmationPages();
    const { url, ticket } = await pages.open(REQUEST);
    expect((await submit(url, { ...CONTACT, action: "confirm" })).status).toBe(422);
    expect((await submit(url, { ...CONTACT, email: "nope", confirm: "yes", action: "confirm" })).status).toBe(422);
    await submit(url, { ...CONTACT, confirm: "yes", action: "confirm" });
    expect((await pages.waitFor(ticket, 10)).granted).toBe(true);
  });

  it("records a decline", async () => {
    pages = new ConfirmationPages();
    const { url, ticket } = await pages.open(REQUEST);
    await submit(url, { action: "decline" });
    expect(await pages.waitFor(ticket, 10)).toMatchObject({ granted: false });
  });

  it("rejects cross-origin posts and foreign Host headers", async () => {
    pages = new ConfirmationPages();
    const { url, ticket } = await pages.open(REQUEST);
    const crossSite = await submit(url, { ...CONTACT, confirm: "yes" }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    // fetch drops a custom Host header; a DNS-rebinding page would arrive with its own host name.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(url, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject).end();
    });
    expect(rebound).toBe(421);
    expect(await pages.waitFor(ticket, 10)).toMatchObject({ granted: false });
  });

  it("answers unknown tickets with 404 and times out waiting", async () => {
    pages = new ConfirmationPages();
    const { url, ticket } = await pages.open(REQUEST);
    expect((await fetch(`${url.slice(0, -4)}AAAA`)).status).toBe(404);
    expect(await pages.waitFor(ticket, 20)).toMatchObject({ granted: false, reason: expect.stringMatching(/in time/) });
    expect((await submit(url, { ...CONTACT, confirm: "yes" })).status).toBe(200);
    expect(await pages.waitFor(ticket, 10)).toMatchObject({ granted: false });
  });
});
