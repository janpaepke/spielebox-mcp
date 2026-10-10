import { LRUCache } from "lru-cache";
import pkg from "../package.json" with { type: "json" };
import { MarkupChangedError } from "./errors.ts";
import { Mutex } from "./mutex.ts";
import { PAGE_SIZE, SORT_IDS } from "./opac.ts";
import { parseDetailPage } from "./parse/detail.ts";
import { checkSearchMessage, loadPage } from "./parse/page.ts";
import { type FacetGroups, type FacetLink, parseResultPage, totalFromFacets } from "./parse/search.ts";
import {
  type FacetValue,
  type Filters,
  type GameDetails,
  type GameSummary,
  type GetGamesParams,
  GetGamesParams as GetGamesParamsSchema,
  type GetGamesResult,
  type NewGamesParams,
  NewGamesParams as NewGamesParamsSchema,
  type SearchParams,
  SearchParams as SearchParamsSchema,
  type SearchResult,
} from "./schema.ts";
import { defaultTransportOptions, Transport, type TransportOptions } from "./transport.ts";

export type SpieleboxClientOptions = Partial<TransportOptions> & {
  /** How long availability (detail pages) is reused. Default 2 min. */
  detailTtlMs?: number;
  /** How long search results are reused. Default 1 min. */
  searchTtlMs?: number;
};

/** How to get a game back into the session's result set, so its detail page resolves. */
type Locator = { kind: "search"; term: string } | { kind: "new" };

type Query = Record<string, string>;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Client for the WIENXTRA-Spielebox online catalog.
 *
 * The OPAC only serves a game's detail page if the game is in the PHP session's last search result set. The client
 * hides this: it remembers (in a bounded index) which search found each game and replays that search when needed.
 * All catalog access is serialized, because each search replaces the session's result set.
 */
export class SpieleboxClient {
  readonly #http: Transport;
  readonly #lock = new Mutex();
  readonly #now: () => number;

  /** Result set of the current OPAC session: its query key and the ids seen in it. */
  #session = { generation: -1, key: "", ids: new Set<string>() };

  readonly #locators = new LRUCache<string, Locator>({ max: 2000 });
  readonly #details: LRUCache<string, GameDetails>;
  readonly #searches: LRUCache<string, SearchResult>;
  /** Keyword label (lowercase) → `cwid`. Ids change on catalog imports, so they expire and are refreshed on mismatch. */
  readonly #keywordIds: LRUCache<string, string>;

  constructor(options: SpieleboxClientOptions = {}) {
    const { detailTtlMs = 120_000, searchTtlMs = 60_000, ...transport } = options;
    const userAgent = `spielebox-client/${pkg.version} (+https://github.com/janpaepke/spielebox-mcp)`;
    const resolved = { ...defaultTransportOptions(userAgent), ...transport };
    this.#http = new Transport(resolved);
    this.#now = resolved.now;
    this.#details = new LRUCache({ max: 500, ttl: detailTtlMs, ttlResolution: 0, perf: { now: resolved.now } });
    this.#keywordIds = new LRUCache({ max: 5000, ttl: DAY_MS, ttlResolution: 0, perf: { now: resolved.now } });
    this.#searches = new LRUCache({ max: 100, ttl: searchTtlMs, ttlResolution: 0, perf: { now: resolved.now } });
  }

  /** Searches the catalog. Range filters (players, age, duration, availability) are applied to the full result list. */
  async search(params: SearchParams): Promise<SearchResult> {
    const p = SearchParamsSchema.parse(params);
    const cacheKey = JSON.stringify(p);
    const cached = this.#searches.get(cacheKey);
    if (cached) return cached;
    return this.#lock.run(async () => {
      const result = await this.#search(p, true);
      this.#searches.set(cacheKey, result);
      return result;
    });
  }

  /** Full details incl. availability of each copy. Ids must come from earlier results of this client. */
  async getGames(params: GetGamesParams): Promise<GetGamesResult> {
    const { ids } = GetGamesParamsSchema.parse(params);
    return this.#lock.run(() => {
      this.#http.dropIdleSession();
      return this.#getGames([...new Set(ids)]);
    });
  }

  /** Available filter values (keywords, players, age, duration, years) with counts for a search term. */
  async getFilters(term: string): Promise<Filters> {
    const { term: t } = SearchParamsSchema.pick({ term: true }).parse({ term });
    return this.#lock.run(async () => {
      const query = { newsearch: "true", sword: t, morecws: "true", moreyears: "true" };
      const page = await this.#fetchResults(query, `search:${t}`, { kind: "search", term: t }, t);
      if (!page) return { term: t, total: 0, keywords: [], players: [], ageFrom: [], duration: [], years: [] };
      this.#learnKeywords(page.facets.Schlagworte);
      const values = (links: FacetLink[] = []): FacetValue[] => links.map(({ label, count }) => ({ label, count }));
      return {
        term: t,
        total: totalFromFacets(page.facets) ?? page.games.length,
        keywords: values(page.facets.Schlagworte),
        players: values(page.facets.SpielerInnen),
        ageFrom: values(page.facets.Alterseignung),
        duration: values(page.facets.Spieldauer),
        years: values(page.facets.Erscheinungsjahr),
      };
    });
  }

  /** Recently acquired games, newest catalog additions first (catalog order). */
  async newGames(params: NewGamesParams = {}): Promise<SearchResult> {
    const { limit, offset } = NewGamesParamsSchema.parse(params);
    return this.#lock.run(() =>
      this.#pagedResults({ newmedia: "true", newsearch: "true" }, "new", { kind: "new" }, "neue Medien", limit, offset),
    );
  }

  async #search(p: ReturnType<typeof SearchParamsSchema.parse>, retryStaleKeyword: boolean): Promise<SearchResult> {
    const query: Query = { newsearch: "true", sword: p.term };
    if (p.sort) query.sortorder = SORT_IDS[p.sort];
    let keywordFromCache = false;
    if (p.keyword) {
      keywordFromCache = this.#keywordIds.has(p.keyword.toLowerCase());
      const id = await this.#resolveKeyword(p.term, p.keyword);
      if (!id) return this.#result([], 0, p.offset);
      query.cwid = id;
    }

    const locator: Locator = { kind: "search", term: p.term };
    const key = `search:${p.term}|${query.cwid ?? ""}`;
    const rangeFilters = p.players ?? p.age ?? p.maxDuration ?? p.availableOnly;
    const result = rangeFilters
      ? await this.#filteredResults(query, key, locator, p)
      : await this.#pagedResults(query, key, locator, p.term, p.limit, p.offset);

    // A cached keyword id may be stale after a catalog import: an unknown id silently yields no hits.
    if (result.total === 0 && keywordFromCache && retryStaleKeyword) {
      this.#keywordIds.clear();
      return this.#search(p, false);
    }
    return result;
  }

  async #filteredResults(
    query: Query,
    key: string,
    locator: Locator,
    p: ReturnType<typeof SearchParamsSchema.parse>,
  ): Promise<SearchResult> {
    const page = await this.#fetchResults({ ...query, printlist: "true" }, key, locator, p.term);
    const games = (page?.games ?? []).filter(
      (g) =>
        (p.players === undefined || (g.players && g.players.min <= p.players && p.players <= g.players.max)) &&
        (p.age === undefined || (g.ageFrom !== null && g.ageFrom <= p.age)) &&
        (p.maxDuration === undefined || (g.maxDurationMinutes !== null && g.maxDurationMinutes <= p.maxDuration)) &&
        (!p.availableOnly || g.availability === "available"),
    );
    return this.#result(games.slice(p.offset, p.offset + p.limit), games.length, p.offset);
  }

  /** Fetches the result pages covering [offset, offset+limit); switches to the printlist when that saves requests. */
  async #pagedResults(
    query: Query,
    key: string,
    locator: Locator,
    term: string,
    limit: number,
    offset: number,
  ): Promise<SearchResult> {
    const firstPage = Math.floor(offset / PAGE_SIZE);
    const lastPage = Math.floor((offset + limit - 1) / PAGE_SIZE);
    if (lastPage - firstPage >= 2) {
      const all = await this.#fetchResults({ ...query, printlist: "true" }, key, locator, term);
      const games = all?.games ?? [];
      return this.#result(games.slice(offset, offset + limit), games.length, offset);
    }

    const first = await this.#fetchResults({ ...query, offset: String(firstPage * PAGE_SIZE) }, key, locator, term);
    if (!first) return this.#result([], 0, offset);
    const total = totalFromFacets(first.facets);
    if (total === null) throw new MarkupChangedError("result page without media type facet");
    const games = [...first.games];
    if (lastPage > firstPage && first.pager && lastPage < first.pager.pages) {
      const next = await this.#fetchResults({ ...query, offset: String(lastPage * PAGE_SIZE) }, key, locator, term);
      games.push(...(next?.games ?? []));
    }
    const start = offset - firstPage * PAGE_SIZE;
    return this.#result(games.slice(start, start + limit), total, offset);
  }

  /**
   * Fetches one result page and records its games: in the locator index and as members of the session's result set.
   * Returns null for "no results".
   */
  async #fetchResults(query: Query, key: string, locator: Locator, term: string) {
    // Any search replaces the session's result set, even a failing one; forget it until this one succeeds.
    const previous = this.#session;
    this.#session = { generation: -1, key: "", ids: new Set() };
    const $ = loadPage(await this.#http.get(query));
    const empty = checkSearchMessage($, term);
    const generation = this.#http.generation;
    this.#session =
      previous.key === key && previous.generation === generation ? previous : { generation, key, ids: new Set() };
    if (empty) return null;
    const page = parseResultPage($);
    for (const game of page.games) {
      this.#locators.set(game.id, locator);
      this.#session.ids.add(game.id);
    }
    return page;
  }

  async #resolveKeyword(term: string, keyword: string): Promise<string | null> {
    const cached = this.#keywordIds.get(keyword.toLowerCase());
    if (cached) return cached;
    const query = { newsearch: "true", sword: term, morecws: "true" };
    const page = await this.#fetchResults(query, `search:${term}|`, { kind: "search", term }, term);
    this.#learnKeywords(page?.facets.Schlagworte);
    // Not among the term's keywords means no game matches both.
    return this.#keywordIds.get(keyword.toLowerCase()) ?? null;
  }

  #learnKeywords(links: FacetGroups["Schlagworte"]): void {
    for (const link of links ?? []) this.#keywordIds.set(link.label.toLowerCase(), link.id);
  }

  async #getGames(ids: string[]): Promise<GetGamesResult> {
    const found = new Map<string, GameDetails>();
    const notFound: GetGamesResult["notFound"] = [];
    const pending: string[] = [];
    for (const id of ids) {
      const cached = this.#details.get(id);
      if (cached) found.set(id, cached);
      else pending.push(id);
    }

    // 1) Ids already in the session's result set.
    const inSession = this.#session.generation === this.#http.generation ? this.#session.ids : new Set<string>();
    const retry: string[] = [];
    for (const id of pending.filter((i) => inSession.has(i))) {
      const game = await this.#fetchDetail(id);
      if (game) found.set(id, game);
      else retry.push(id);
    }

    // 2) Replay the search that found them, one search per locator.
    const groups = new Map<string, { locator: Locator; ids: string[] }>();
    for (const id of [...pending.filter((i) => !inSession.has(i)), ...retry]) {
      const locator = this.#locators.get(id);
      if (!locator) {
        notFound.push({ id, reason: "Unknown id: search for the game first" });
        continue;
      }
      const key = locator.kind === "new" ? "new" : `search:${locator.term}|`;
      const group = groups.get(key) ?? { locator, ids: [] };
      group.ids.push(id);
      groups.set(key, group);
    }
    for (const [key, { locator, ids: groupIds }] of groups) {
      const query: Query =
        locator.kind === "new" ? { newmedia: "true", newsearch: "true" } : { newsearch: "true", sword: locator.term };
      await this.#fetchResults(query, key, locator, locator.kind === "new" ? "neue Medien" : locator.term);
      for (const id of groupIds) {
        const game = await this.#fetchDetail(id);
        if (game) found.set(id, game);
        else notFound.push({ id, reason: "Not found in the catalog anymore" });
      }
    }

    const games = ids.flatMap((id) => found.get(id) ?? []);
    return { games, notFound };
  }

  async #fetchDetail(id: string): Promise<GameDetails | null> {
    const game = parseDetailPage(loadPage(await this.#http.get({ media: id })), id, new Date(this.#now()));
    if (game) this.#details.set(id, game);
    return game;
  }

  #result(games: GameSummary[], total: number, offset: number): SearchResult {
    return { total, offset, games, asOf: new Date(this.#now()).toISOString() };
  }
}
