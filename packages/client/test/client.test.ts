import { beforeEach, describe, expect, it } from "vitest";
import { SpieleboxClient } from "../src/client.ts";
import { HttpError, TooManyResultsError } from "../src/errors.ts";
import { FakeOpac } from "./fake-opac.ts";

const CONNECT = "3375ddafbc45fed35c0da0b4cc481084";
const MENSCHHEIT = "c1d18eefb1bd1698c74653c0980f950d";
const DECKBUILDING_CWID = "6ac98e1b36ce6";

let opac: FakeOpac;
let clock: number;
let client: SpieleboxClient;

beforeEach(() => {
  opac = new FakeOpac();
  clock = Date.parse("2026-10-11T12:00:00Z");
  client = new SpieleboxClient({ fetch: opac.fetch, minIntervalMs: 0, retries: 0, now: () => clock });
});

describe("search", () => {
  it("returns the first page with the total from the facets", async () => {
    const result = await client.search({ term: "catan" });
    expect(result).toMatchObject({ total: 62, offset: 0 });
    expect(result.games).toHaveLength(20);
    expect(opac.log).toEqual(["newsearch=true&sword=catan&offset=0"]);
  });

  it("stitches a window spanning two pages", async () => {
    const result = await client.search({ term: "catan", offset: 15, limit: 10 });
    expect(result.games).toHaveLength(10);
    expect(opac.log).toEqual(["newsearch=true&sword=catan&offset=0", "newsearch=true&sword=catan&offset=20"]);
  });

  it("uses the printlist for large windows", async () => {
    const result = await client.search({ term: "catan", limit: 60 });
    expect(result.games).toHaveLength(60);
    expect(opac.log).toEqual(["newsearch=true&sword=catan&printlist=true"]);
  });

  it("applies range filters to the full list", async () => {
    const result = await client.search({ term: "catan", players: 5, age: 10, maxDuration: 60 });
    expect(result.total).toBeGreaterThan(0);
    for (const g of result.games) {
      expect(g.players?.min).toBeLessThanOrEqual(5);
      expect(g.players?.max).toBeGreaterThanOrEqual(5);
      expect(g.ageFrom).toBeLessThanOrEqual(10);
      expect(g.maxDurationMinutes).toBeLessThanOrEqual(60);
    }
    expect(opac.log).toEqual(["newsearch=true&sword=catan&printlist=true"]);
  });

  it("resolves keywords by label and caches the id", async () => {
    await client.search({ term: "catan", keyword: "deckbuildingspiele" });
    await client.search({ term: "catan", keyword: "Deckbuildingspiele", limit: 5 });
    expect(opac.log).toEqual([
      "newsearch=true&sword=catan&morecws=true",
      `newsearch=true&sword=catan&cwid=${DECKBUILDING_CWID}&offset=0`,
      `newsearch=true&sword=catan&cwid=${DECKBUILDING_CWID}&offset=0`,
    ]);
  });

  it("returns no games for a keyword the term doesn't have", async () => {
    const result = await client.search({ term: "catan", keyword: "Gibt es nicht" });
    expect(result.total).toBe(0);
    expect(opac.log).toHaveLength(1);
  });

  it("sends the sort order", async () => {
    await client.search({ term: "catan", sort: "year" });
    expect(opac.log[0]).toContain("sortorder=e884abab76eeda623d89f8cc133a3b54");
  });

  it("returns an empty result for no hits and throws for too many", async () => {
    expect((await client.search({ term: "xqzzqx" })).total).toBe(0);
    await expect(client.search({ term: "spiel" })).rejects.toThrow(TooManyResultsError);
  });

  it("rejects terms shorter than 3 characters before calling the catalog", async () => {
    await expect(client.search({ term: "ab" })).rejects.toThrow();
    expect(opac.log).toEqual([]);
  });

  it("caches identical searches for a minute", async () => {
    await client.search({ term: "catan" });
    await client.search({ term: "catan" });
    clock += 61_000;
    await client.search({ term: "catan" });
    expect(opac.log).toHaveLength(2);
  });
});

describe("getGames", () => {
  it("fetches details directly when the game is in the session's result set", async () => {
    await client.search({ term: "catan" });
    const { games, notFound } = await client.getGames({ ids: [CONNECT] });
    expect(games[0]?.copies).toHaveLength(2);
    expect(notFound).toEqual([]);
    expect(opac.log.slice(1)).toEqual([`media=${CONNECT}`]);
  });

  it("resolves hits beyond the first page, since the session holds the full result set", async () => {
    await client.search({ term: "catan", limit: 1 });
    const { games } = await client.getGames({ ids: [MENSCHHEIT] });
    expect(games[0]?.title).toBe("ABENTEUER MENSCHHEIT");
  });

  it("replays the original search after another search replaced the result set", async () => {
    await client.search({ term: "catan" });
    await client.search({ term: "catan connect" });
    const { games } = await client.getGames({ ids: [MENSCHHEIT, CONNECT] });
    expect(games.map((g) => g.title)).toEqual(["ABENTEUER MENSCHHEIT", "CATAN Connect"]);
    expect(opac.log.slice(2)).toEqual([
      `media=${CONNECT}`, // still in the "catan connect" result set
      "newsearch=true&sword=catan", // replay for MENSCHHEIT
      `media=${MENSCHHEIT}`,
    ]);
  });

  it("starts a new session after 20 minutes idle and replays the search", async () => {
    await client.search({ term: "catan" });
    clock += 21 * 60_000;
    opac.expireSessions();
    const { games } = await client.getGames({ ids: [CONNECT] });
    expect(games).toHaveLength(1);
    expect(opac.log.slice(1)).toEqual(["newsearch=true&sword=catan", `media=${CONNECT}`]);
  });

  it("recovers when the server expired the session early", async () => {
    await client.search({ term: "catan" });
    opac.expireSessions();
    const { games } = await client.getGames({ ids: [CONNECT] });
    expect(games).toHaveLength(1);
    expect(opac.log.slice(1)).toEqual([`media=${CONNECT}`, "newsearch=true&sword=catan", `media=${CONNECT}`]);
  });

  it("reports ids it never saw", async () => {
    const { games, notFound } = await client.getGames({ ids: [CONNECT] });
    expect(games).toEqual([]);
    expect(notFound).toEqual([{ id: CONNECT, reason: expect.stringMatching(/search for the game first/) }]);
    expect(opac.log).toEqual([]);
  });

  it("caches details for two minutes", async () => {
    await client.search({ term: "catan" });
    await client.getGames({ ids: [CONNECT] });
    await client.getGames({ ids: [CONNECT] });
    clock += 121_000;
    await client.getGames({ ids: [CONNECT] });
    expect(opac.log.filter((l) => l.startsWith("media="))).toHaveLength(2);
  });

  it("serializes concurrent calls so searches don't break each other's details", async () => {
    await client.search({ term: "catan" });
    const [, details] = await Promise.all([
      client.search({ term: "catan connect" }),
      client.getGames({ ids: [MENSCHHEIT] }),
    ]);
    expect(details.games).toHaveLength(1);
  });
});

describe("getFilters", () => {
  it("lists all keywords and facet values with counts", async () => {
    const filters = await client.getFilters("catan");
    expect(filters.total).toBe(62);
    expect(filters.keywords.length).toBeGreaterThan(10);
    expect(filters.players.map((p) => p.label)).toContain("für 4 SpielerIn(nen)");
    expect(opac.log).toEqual(["newsearch=true&sword=catan&morecws=true&moreyears=true"]);
  });

  it("lets getGames use the result set getFilters entered", async () => {
    await client.getFilters("catan");
    await client.getGames({ ids: [CONNECT] });
    expect(opac.log.slice(1)).toEqual([`media=${CONNECT}`]);
  });
});

describe("newGames", () => {
  it("lists new games and remembers how to find them again", async () => {
    const result = await client.newGames({ limit: 5 });
    expect(result.games).toHaveLength(5);
    expect(result.total).toBeGreaterThan(20);
  });
});

describe("reservation list", () => {
  it("adds known games once, in order, with availability", async () => {
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids: [MENSCHHEIT] });
    const list = await client.addToReservationList({ ids: [CONNECT, MENSCHHEIT] });
    expect(list.items.map((i) => i.title)).toEqual(["ABENTEUER MENSCHHEIT", "CATAN Connect"]);
    expect(list.items[1]).toMatchObject({ availableCopies: 2, onlineReservationRequired: false });
    expect(list.notFound).toEqual([]);
  });

  it("doesn't add ids it can't resolve", async () => {
    const list = await client.addToReservationList({ ids: [CONNECT] });
    expect(list.items).toEqual([]);
    expect(list.notFound).toHaveLength(1);
  });

  it("removes and clears without contacting the catalog", async () => {
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids: [CONNECT, MENSCHHEIT] });
    const requests = opac.log.length;
    expect((await client.removeFromReservationList({ ids: [CONNECT] })).items.map((i) => i.id)).toEqual([MENSCHHEIT]);
    expect((await client.clearReservationList()).items).toEqual([]);
    expect(opac.log).toHaveLength(requests);
  });

  it("refreshes availability when shown after the cache expired, even across sessions", async () => {
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids: [CONNECT] });
    await client.search({ term: "catan connect" });
    clock += 25 * 60_000;
    opac.expireSessions();
    const list = await client.getReservationList();
    expect(list.items).toHaveLength(1);
    expect(list.asOf).toBe(new Date(clock).toISOString());
    expect(opac.log.at(-1)).toBe(`media=${CONNECT}`);
  });

  it("refuses to grow beyond the catalog's limit of 6 games", async () => {
    const ids = (await client.search({ term: "catan", limit: 7 })).games.map((g) => g.id);
    await expect(client.addToReservationList({ ids: ids.slice(0, 6) })).resolves.toBeDefined();
    await expect(client.addToReservationList({ ids: ids.slice(6, 7) })).rejects.toMatchObject({
      code: "RESERVATION_LIST_FULL",
    });
  });
});

describe("reservation request", () => {
  const contact = { firstName: "Erika", lastName: "Muster", email: "erika@example.org", phone: "+43 1 234" };

  let listed: string[] = [];
  async function listOf(ids: string[]) {
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids });
    listed = ids;
    opac.requests.length = 0;
  }

  it("re-checks availability without the cache when preparing", async () => {
    await listOf([CONNECT]);
    const list = await client.prepareReservationRequest();
    expect(list.items).toHaveLength(1);
    expect(opac.log).toEqual([`media=${CONNECT}`]);
  });

  it("puts the games on a fresh Merkliste, checks the form and submits it once", async () => {
    await listOf([CONNECT, MENSCHHEIT]);
    const result = await client.submitReservationRequest({ contact, ids: listed });
    expect(result).toMatchObject({ status: "sent", titles: ["ABENTEUER MENSCHHEIT", "CATAN Connect"] });
    expect(result.message).toContain("Vielen Dank");
    expect(opac.log.slice(-5)).toEqual([
      "newsearch=true&sword=catan",
      `basket=add&media=${CONNECT}`,
      `basket=add&media=${MENSCHHEIT}`,
      "orderbasket=true",
      "orderbasket=true",
    ]);
    expect(opac.orders).toHaveLength(1);
    expect(Object.fromEntries(opac.orders[0] ?? [])).toEqual({
      location: "sb",
      order: "token1",
      firstname: "Erika",
      lastname: "Muster",
      email: "erika@example.org",
      phone: "+43 1 234",
      agb: "ja",
    });
    expect((await client.getReservationList()).items).toEqual([]);
  });

  it("refuses when a game is no longer available, before touching the Merkliste", async () => {
    await client.search({ term: "catan" });
    const borrowed = (await client.search({ term: "catan", limit: 30 })).games.find(
      (g) => g.id !== CONNECT && g.id !== MENSCHHEIT,
    );
    await client.addToReservationList({ ids: [borrowed?.id ?? ""] }); // stand-in detail page: all copies borrowed
    listed = [borrowed?.id ?? ""];
    opac.requests.length = 0;
    await expect(client.submitReservationRequest({ contact, ids: listed })).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
    expect(opac.log.some((l) => l.startsWith("basket="))).toBe(false);
    expect(opac.orders).toEqual([]);
  });

  it("aborts and clears the Merkliste when the catalog can't reserve a game", async () => {
    await listOf([CONNECT, MENSCHHEIT]);
    opac.notOrderable.add(MENSCHHEIT);
    await expect(client.submitReservationRequest({ contact, ids: listed })).rejects.toMatchObject({
      code: "NOT_ORDERABLE",
    });
    expect(opac.log.at(-1)).toBe("deletebasket=1");
    expect(opac.orders).toEqual([]);
    expect((await client.getReservationList()).items).toHaveLength(2);
  });

  it("aborts when the order form doesn't list exactly the expected games", async () => {
    await listOf([CONNECT, MENSCHHEIT]);
    opac.ignoreAdds.add(CONNECT);
    await expect(client.submitReservationRequest({ contact, ids: listed })).rejects.toMatchObject({
      code: "ORDER_MISMATCH",
    });
    expect(opac.orders).toEqual([]);
  });

  it("reports a rejected submission and keeps the list", async () => {
    await listOf([CONNECT]);
    opac.orderOutcome = "error";
    await expect(client.submitReservationRequest({ contact, ids: listed })).rejects.toMatchObject({
      code: "ORDER_REJECTED",
    });
    expect((await client.getReservationList()).items).toHaveLength(1);
  });

  it("refuses when the list differs from the confirmed games", async () => {
    await listOf([CONNECT, MENSCHHEIT]);
    await expect(client.submitReservationRequest({ contact, ids: [CONNECT] })).rejects.toMatchObject({
      code: "RESERVATION_LIST_CHANGED",
    });
    expect(opac.log).toEqual([]);
  });

  it("never retries the submission", async () => {
    await listOf([CONNECT]);
    opac.orderOutcome = "network";
    await expect(client.submitReservationRequest({ contact, ids: listed })).rejects.toBeInstanceOf(HttpError);
    expect(opac.orders).toHaveLength(1);
  });

  it("validates contact data and refuses an empty list before any request", async () => {
    await expect(
      client.submitReservationRequest({ contact: { ...contact, email: "nope" }, ids: [] }),
    ).rejects.toThrow();
    await expect(client.submitReservationRequest({ contact, ids: listed })).rejects.toMatchObject({
      code: "RESERVATION_LIST_EMPTY",
    });
    expect(opac.log).toEqual([]);
  });
});

describe("planOrderFormHandoff", () => {
  const url = (params: string) => `https://opac.wienxtra.at/index.php?${params}&location=sb`;

  it("plans clear → one search per group → adds → order form, without touching the Merkliste itself", async () => {
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids: [CONNECT, MENSCHHEIT] });
    opac.requests.length = 0;
    const plan = await client.planOrderFormHandoff();
    expect(plan.items.map((i) => i.title)).toEqual(["CATAN Connect", "ABENTEUER MENSCHHEIT"]);
    expect(plan.steps).toEqual([
      { kind: "clear", url: url("deletebasket=1") },
      { kind: "search", url: url("newsearch=true&sword=catan") },
      { kind: "add", url: url(`basket=add&media=${CONNECT}`) },
      { kind: "add", url: url(`basket=add&media=${MENSCHHEIT}`) },
      { kind: "form", url: url("orderbasket=true") },
    ]);
    // Only fresh availability was read; nothing was put on a Merkliste.
    expect(opac.log.every((l) => l.startsWith("media=") || l.startsWith("newsearch="))).toBe(true);
  });

  it("uses one search per locator", async () => {
    opac.standInDetail = "detail-catan-connect.html"; // games without a fixture count as available
    const fresh = (await client.newGames({ limit: 1 })).games[0]?.id ?? "";
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids: [MENSCHHEIT, fresh] });
    const steps = (await client.planOrderFormHandoff()).steps;
    expect(steps.map((s) => s.kind)).toEqual(["clear", "search", "add", "search", "add", "form"]);
    expect(steps[1]?.url).toContain("sword=catan&");
    expect(steps[3]?.url).toContain("newmedia=true");
  });

  it("shares one search between games that the same search found", async () => {
    await client.search({ term: "catan connect" });
    await client.search({ term: "catan" });
    await client.addToReservationList({ ids: [CONNECT, MENSCHHEIT] });
    expect((await client.planOrderFormHandoff()).steps.filter((s) => s.kind === "search")).toHaveLength(1);
  });

  it("refuses an empty list and unavailable games", async () => {
    await expect(client.planOrderFormHandoff()).rejects.toMatchObject({ code: "RESERVATION_LIST_EMPTY" });
    const borrowed = (await client.search({ term: "catan", limit: 30 })).games.find(
      (g) => g.id !== CONNECT && g.id !== MENSCHHEIT,
    );
    await client.addToReservationList({ ids: [borrowed?.id ?? ""] }); // stand-in detail page: all copies borrowed
    await expect(client.planOrderFormHandoff()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });
});

describe("planGamePageHandoff", () => {
  it("plans the search that found the game, then its detail page", async () => {
    await client.search({ term: "catan" });
    await client.search({ term: "catan connect" });
    const plan = await client.planGamePageHandoff({ id: MENSCHHEIT });
    expect(plan.title).toBe("ABENTEUER MENSCHHEIT");
    expect(plan.steps).toEqual([
      { kind: "search", url: "https://opac.wienxtra.at/index.php?newsearch=true&sword=catan&location=sb" },
      { kind: "detail", url: `https://opac.wienxtra.at/index.php?media=${MENSCHHEIT}&location=sb` },
    ]);
  });

  it("refuses ids it never saw", async () => {
    await expect(client.planGamePageHandoff({ id: CONNECT })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(opac.log).toEqual([]);
  });
});
