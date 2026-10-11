import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TermTooShortError, TooManyResultsError } from "../src/errors.ts";
import { parseDetailPage } from "../src/parse/detail.ts";
import { checkSearchMessage, loadPage } from "../src/parse/page.ts";
import { parseResultPage, totalFromFacets } from "../src/parse/search.ts";

const fixture = (name: string) => loadPage(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const NOW = new Date("2026-10-11T12:00:00Z");

describe("parseResultPage", () => {
  const page = parseResultPage(fixture("search-catan.html"));

  it("parses 20 hits, the pager and the total", () => {
    expect(page.games).toHaveLength(20);
    expect(page.pager).toEqual({ page: 1, pages: 4 });
    expect(totalFromFacets(page.facets)).toBe(62);
  });

  it("parses a hit with all fields", () => {
    expect(page.games[0]).toMatchObject({
      id: "c1d18eefb1bd1698c74653c0980f950d",
      title: "ABENTEUER MENSCHHEIT",
      availability: expect.any(String),
      authors: ["Teuber, Klaus"],
      publisher: "Kosmos",
      year: 2002,
      ageFrom: 10,
      maxDurationMinutes: 90,
      players: { min: 3, max: 4 },
      descriptionTruncated: true,
      onlineReservationRequired: true,
    });
    expect(page.games[0]?.description).toMatch(/^Die Wiege des modernen Menschen.*…$/);
    expect(page.games[0]?.keywords).toContain("Strategiespiele");
  });

  it("splits multiple authors and drops truncated keywords", () => {
    const connect = page.games.find((g) => g.title === "CATAN Connect");
    expect(connect?.authors).toEqual(["Teuber, Klaus", "Teuber, Benjamin"]);
    expect(connect?.keywordsTruncated).toBe(true);
    expect(connect?.keywords.at(-1)).toBe("Handelsspiele");
    expect(connect?.onlineReservationRequired).toBe(false);
  });

  it("parses facets with ids", () => {
    expect(page.facets.SpielerInnen?.map((f) => f.label)).toContain("für 4 SpielerIn(nen)");
    expect(page.facets.Alterseignung?.find((f) => f.label === "ab 10 Jahren")).toMatchObject({
      count: 27,
      param: "agefromid",
      id: "d3d9446802a44259755d38e6d163e820", // md5("10")
    });
    expect(page.facets.Schlagworte).toHaveLength(10);
  });

  it("lists all keywords with morecws", () => {
    expect(parseResultPage(fixture("search-catan-morecws.html")).facets.Schlagworte?.length).toBeGreaterThan(10);
  });

  it("parses the full printlist without pager or facets", () => {
    const all = parseResultPage(fixture("search-catan-printlist.html"));
    expect(all.games).toHaveLength(62);
    expect(all.facets).toEqual({});
    expect(new Set(all.games.map((g) => g.id)).size).toBe(62);
  });

  it("skips the reset link of an active facet", () => {
    const filtered = parseResultPage(fixture("search-catan-keyword.html"));
    expect(filtered.facets.Schlagworte?.map((f) => f.label)).toEqual(["Kooperationsspiele"]);
    expect(totalFromFacets(filtered.facets)).toBe(filtered.games.length);
  });

  it("parses page 2 and the new games list", () => {
    expect(parseResultPage(fixture("search-catan-page2.html")).pager).toEqual({ page: 2, pages: 4 });
    expect(parseResultPage(fixture("new-games.html")).games).toHaveLength(20);
  });
});

describe("checkSearchMessage", () => {
  it("returns false for normal result pages", () =>
    expect(checkSearchMessage(fixture("search-catan.html"), "catan")).toBe(false));
  it("returns true for no results", () =>
    expect(checkSearchMessage(fixture("search-no-results.html"), "x")).toBe(true));
  it("throws for too short terms", () =>
    expect(() => checkSearchMessage(fixture("search-too-short.html"), "ab")).toThrow(TermTooShortError));
  it("throws for too many results", () =>
    expect(() => checkSearchMessage(fixture("search-too-many.html"), "spiel")).toThrow(TooManyResultsError));
});

describe("parseDetailPage", () => {
  it("parses copies and exact ranges", () => {
    const game = parseDetailPage(fixture("detail-catan-connect.html"), "3375ddafbc45fed35c0da0b4cc481084", NOW);
    expect(game).toMatchObject({
      title: "CATAN Connect",
      authors: ["Teuber, Klaus", "Teuber, Benjamin"],
      durationMinutes: { min: 30, max: 45 },
      players: { min: 4, max: 6 },
      onlineReservationRequired: false,
      asOf: "2026-10-11T12:00:00.000Z",
    });
    expect(game?.copies.map((c) => c.copyNo)).toEqual(["54559", "54612"]);
    expect(game?.description).not.toMatch(/…$/);
    expect(game?.keywords).toContain("Sammeln + Ausliefern");
  });

  it("reads the online reservation note", () => {
    const game = parseDetailPage(fixture("detail-abenteuer-menschheit.html"), "c1d18eefb1bd1698c74653c0980f950d", NOW);
    expect(game?.onlineReservationRequired).toBe(true);
    expect(game?.durationMinutes).toEqual({ min: 60, max: 90 });
  });

  it("derives availability from copies", () => {
    const game = parseDetailPage(fixture("detail-galaxy-trucker.html"), "48c1c1cfe38d8291bb6b2f09319c58df", NOW);
    expect(game?.copies).toEqual([{ copyNo: "38068", availability: "borrowed" }]);
    expect(game?.availability).toBe("borrowed");
    expect(game?.availableCopies).toBe(0);
  });

  it("returns null for the session error box", () => {
    expect(parseDetailPage(fixture("detail-not-in-session.html"), "3375ddafbc45fed35c0da0b4cc481084", NOW)).toBeNull();
  });
});
