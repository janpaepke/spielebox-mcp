/**
 * Re-downloads the HTML fixtures used by the parser tests from the live OPAC.
 *
 * Read-only: only GET requests for searches and detail pages. Run with `pnpm fixtures`.
 * Uses plain fetch on purpose, so fixtures don't depend on the client under test.
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://opac.wienxtra.at/index.php";
const OUT = new URL("../test/fixtures/", import.meta.url);
const USER_AGENT = "spielebox-mcp fixture refresh (+https://github.com/janpaepke/spielebox-mcp)";

let cookie = "";

async function get(params: Record<string, string>): Promise<string> {
  const url = `${BASE}?${new URLSearchParams({ ...params, location: "sb" })}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, ...(cookie && { cookie }) } });
  const session = res.headers.getSetCookie().find((c) => c.startsWith("wienXtraopac="));
  if (session) cookie = session.split(";")[0] ?? "";
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  await new Promise((r) => setTimeout(r, 500));
  return res.text();
}

async function save(name: string, html: string): Promise<void> {
  await writeFile(new URL(name, OUT), html);
  console.log(`${name.padEnd(36)} ${html.length.toString().padStart(7)} chars`);
}

const search = (sword: string, extra: Record<string, string> = {}) => get({ newsearch: "true", sword, ...extra });

await mkdir(OUT, { recursive: true });

await save("search-catan.html", await search("catan"));
await save("search-catan-page2.html", await search("catan", { offset: "20" }));
await save("search-catan-printlist.html", await search("catan", { printlist: "true" }));
const morecws = await search("catan", { morecws: "true" });
await save("search-catan-morecws.html", morecws);
const coop = /cwid=([0-9a-f]+)"[^>]*title="Kooperationsspiele"/.exec(morecws)?.[1];
if (!coop) throw new Error("keyword Kooperationsspiele not found");
await save("search-catan-keyword.html", await search("catan", { cwid: coop }));
await save("search-single-hit.html", await search("catan connect"));
await save("search-no-results.html", await search("xqzzqx"));
await save("search-too-many.html", await search("spiel"));
await save("search-too-short.html", await search("ab"));
await save("new-games.html", await get({ newmedia: "true", newsearch: "true" }));

// Detail pages need the id in the session's last result set: search first, same cookie.
await search("catan connect");
await save("detail-catan-connect.html", await get({ media: "3375ddafbc45fed35c0da0b4cc481084" }));
await search("abenteuer menschheit");
await save("detail-abenteuer-menschheit.html", await get({ media: "c1d18eefb1bd1698c74653c0980f950d" }));
await search("galaxy trucker");
await save("detail-galaxy-trucker.html", await get({ media: "48c1c1cfe38d8291bb6b2f09319c58df" }));

cookie = "";
await save("detail-not-in-session.html", await get({ media: "3375ddafbc45fed35c0da0b4cc481084" }));
