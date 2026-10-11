import { describe, expect, it } from "vitest";
import { SpieleboxClient } from "../src/client.ts";

/**
 * Canary against the real catalog: read-only, a handful of requests. Run with `pnpm test:live`.
 * Fails when the site's markup or behavior changed; refresh fixtures with `pnpm fixtures` and compare.
 */
describe.runIf(process.env.SPIELEBOX_LIVE === "1")("live catalog", () => {
  const client = new SpieleboxClient();

  it("searches, filters and resolves details across searches", { timeout: 60_000 }, async () => {
    const catan = await client.search({ term: "catan" });
    expect(catan.total).toBeGreaterThan(20);
    expect(catan.games).toHaveLength(20);

    const filtered = await client.search({ term: "catan", players: 4, age: 10, availableOnly: true });
    expect(filtered.games.every((g) => g.availability === "available")).toBe(true);

    const coop = await client.search({ term: "catan", keyword: "Kooperationsspiele" });
    expect(coop.total).toBeGreaterThan(0);
    expect(coop.total).toBeLessThan(catan.total);

    await client.search({ term: "flügelschlag" });
    const lastCatan = catan.games.at(-1);
    if (!lastCatan) throw new Error("no games");
    const { games, notFound } = await client.getGames({ ids: [lastCatan.id] });
    expect(notFound).toEqual([]);
    expect(games[0]?.title).toBe(lastCatan.title);
    expect(games[0]?.copies.length).toBeGreaterThan(0);
  });

  it("lists filters and new games", { timeout: 60_000 }, async () => {
    const filters = await client.getFilters("kooperativ");
    expect(filters.keywords.length).toBeGreaterThan(10);
    const fresh = await client.newGames({ limit: 3 });
    expect(fresh.games).toHaveLength(3);
  });
});
