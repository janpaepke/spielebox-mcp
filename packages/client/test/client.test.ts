import { beforeEach, describe, expect, it } from "vitest";
import { SpieleboxClient } from "../src/client.ts";
import { TooManyResultsError } from "../src/errors.ts";
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

  it("refuses to grow beyond its limit", async () => {
    await client.search({ term: "catan", limit: 100 });
    const ids = (await client.search({ term: "catan", limit: 31 })).games.map((g) => g.id);
    await expect(client.addToReservationList({ ids: ids.slice(0, 20) })).resolves.toBeDefined();
    await expect(client.addToReservationList({ ids: ids.slice(20, 31) })).rejects.toMatchObject({
      code: "RESERVATION_LIST_FULL",
    });
  });
});
