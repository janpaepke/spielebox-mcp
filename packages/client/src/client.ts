import { LRUCache } from "lru-cache";
import pkg from "../package.json" with { type: "json" };
import { MarkupChangedError, SpieleboxError } from "./errors.ts";
import { Mutex } from "./mutex.ts";
import { PAGE_SIZE, SORT_IDS } from "./opac.ts";
import { parseDetailPage } from "./parse/detail.ts";
import { parseOrderForm, parseOrderResponse } from "./parse/order.ts";
import { checkSearchMessage, loadPage } from "./parse/page.ts";
import { type FacetGroups, type FacetLink, parseResultPage, totalFromFacets } from "./parse/search.ts";
import {
  type Contact,
  Contact as ContactSchema,
  type FacetValue,
  type Filters,
  type GameDetails,
  type GamePageParams,
  GamePageParams as GamePageParamsSchema,
  type GamePagePlan,
  type GameSummary,
  type GetGamesParams,
  GetGamesParams as GetGamesParamsSchema,
  type GetGamesResult,
  type HandoffPlan,
  type HandoffStep,
  type NewGamesParams,
  NewGamesParams as NewGamesParamsSchema,
  type ReservationList,
  type ReservationListChange,
  ReservationListChange as ReservationListChangeSchema,
  type ReservationRequestResult,
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
 * Identifies a result set on the OPAC: which games a search puts into the session. Sorting and paging don't change it,
 * a keyword facet narrows it.
 */
const resultSetKey = (locator: Locator, keywordId = "") =>
  locator.kind === "new" ? "new" : `search:${locator.term}|${keywordId}`;

/** The plain search that puts a locator's games into the session's result set. */
const locatorQuery = (locator: Locator): Query =>
  locator.kind === "new" ? { newmedia: "true", newsearch: "true" } : { newsearch: "true", sword: locator.term };

/** The catalog accepts at most 6 games per reservation request ("Maximal können 6 Medien … vorbestellt werden"). */
export const RESERVATION_LIST_MAX = 6;

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
  /** Reservation list: ids in insertion order. Their locators are pinned here so LRU eviction can't drop them. */
  readonly #reservationList = new Set<string>();
  readonly #pinnedLocators = new Map<string, Locator>();
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
      const page = await this.#fetchResults(
        query,
        resultSetKey({ kind: "search", term: t }),
        { kind: "search", term: t },
        t,
      );
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
      this.#pagedResults(
        { newmedia: "true", newsearch: "true" },
        resultSetKey({ kind: "new" }),
        { kind: "new" },
        "neue Medien",
        limit,
        offset,
      ),
    );
  }

  /** Adds games to the reservation list. Only games the client has seen in results can be added. */
  async addToReservationList(params: ReservationListChange): Promise<ReservationList> {
    const { ids } = ReservationListChangeSchema.parse(params);
    return this.#lock.run(async () => {
      this.#http.dropIdleSession();
      const fresh = [...new Set(ids)].filter((id) => !this.#reservationList.has(id));
      if (this.#reservationList.size + fresh.length > RESERVATION_LIST_MAX) {
        throw new SpieleboxError(
          "RESERVATION_LIST_FULL",
          `The Spielebox takes at most ${RESERVATION_LIST_MAX} games per reservation request`,
        );
      }
      const { games, notFound } = await this.#getGames(fresh);
      for (const game of games) {
        this.#reservationList.add(game.id);
        const locator = this.#locators.get(game.id);
        if (locator) this.#pinnedLocators.set(game.id, locator);
      }
      return this.#describeReservationList(notFound);
    });
  }

  /** Removes games from the reservation list. Ids that aren't on it are ignored. */
  async removeFromReservationList(params: ReservationListChange): Promise<ReservationList> {
    const { ids } = ReservationListChangeSchema.parse(params);
    return this.#lock.run(async () => {
      for (const id of ids) {
        this.#reservationList.delete(id);
        this.#pinnedLocators.delete(id);
      }
      return this.#describeReservationList([]);
    });
  }

  async clearReservationList(): Promise<ReservationList> {
    return this.#lock.run(async () => {
      this.#reservationList.clear();
      this.#pinnedLocators.clear();
      return this.#describeReservationList([]);
    });
  }

  /** The reservation list with current availability. */
  async getReservationList(): Promise<ReservationList> {
    return this.#lock.run(() => {
      this.#http.dropIdleSession();
      return this.#describeReservationList([]);
    });
  }

  /** The reservation list with availability fetched fresh from the catalog (no cache), as the basis for a request. */
  async prepareReservationRequest(): Promise<ReservationList> {
    return this.#lock.run(() => {
      this.#http.dropIdleSession();
      for (const id of this.#reservationList) this.#details.delete(id);
      return this.#describeReservationList([]);
    });
  }

  /**
   * Plans opening a game's catalog detail page in the user's browser. Detail pages only resolve within a session whose
   * last search found the game, so the browser runs that search first. Only games the client has seen can be planned.
   */
  async planGamePageHandoff(params: GamePageParams): Promise<GamePagePlan> {
    const { id } = GamePageParamsSchema.parse(params);
    return this.#lock.run(async () => {
      this.#http.dropIdleSession();
      const { groups } = this.#groupByLocator([id]);
      const [group] = groups;
      if (!group) throw new SpieleboxError("NOT_FOUND", "Unknown game: search for it first");
      const { games } = await this.#getGames([id]);
      const title = games[0]?.title;
      if (!title) throw new SpieleboxError("NOT_FOUND", "Game not found in the catalog anymore");
      return {
        title,
        steps: [
          { kind: "search", url: this.#http.url(locatorQuery(group.locator)) },
          { kind: "detail", url: this.#http.url({ media: id }) },
        ],
      };
    });
  }

  /**
   * Plans the handoff of the reservation list to the user's browser: the catalog pages the browser has to load so that
   * its own Merkliste holds exactly these games and it ends on the catalog's order form. The user then submits the
   * request there, on the official site; nothing is sent by the client. Availability is checked fresh first.
   */
  async planOrderFormHandoff(): Promise<HandoffPlan> {
    return this.#lock.run(async () => {
      this.#http.dropIdleSession();
      const ids = [...this.#reservationList];
      if (!ids.length) throw new SpieleboxError("RESERVATION_LIST_EMPTY", "The reservation list is empty");
      for (const id of ids) this.#details.delete(id);
      const list = await this.#describeReservationList([]);
      if (list.notFound.length) {
        throw new SpieleboxError("NOT_FOUND", `Games not found anymore: ${list.notFound.map((n) => n.id).join(", ")}`);
      }
      const unavailable = list.items.filter((i) => i.availability !== "available").map((i) => i.title);
      if (unavailable.length)
        throw new SpieleboxError("NOT_AVAILABLE", `Not available right now: ${unavailable.join(", ")}`);

      const { groups, unknown } = this.#groupByLocator(ids);
      if (unknown.length) throw new SpieleboxError("NOT_FOUND", `Unknown games: ${unknown.join(", ")}`);
      // Start from an empty Merkliste, so the order form lists exactly the reservation list.
      const steps: HandoffStep[] = [{ kind: "clear", url: this.#http.url({ deletebasket: "1" }) }];
      for (const { locator, ids: groupIds } of groups) {
        steps.push({ kind: "search", url: this.#http.url(locatorQuery(locator)) });
        for (const id of groupIds) steps.push({ kind: "add", url: this.#http.url({ basket: "add", media: id }) });
      }
      steps.push({ kind: "form", url: this.#http.url({ orderbasket: "true" }) });
      return { items: list.items, steps };
    });
  }

  /**
   * Sends the reservation list to the catalog as a reservation request. **Binding for the user**: the catalog e-mails
   * the request to the staff, who prepare the games and confirm by e-mail. Callers must obtain the user's explicit
   * consent first, and pass the ids the user confirmed: the request is only sent if they are exactly the reservation
   * list at that moment. Never retried; on success the reservation list is cleared.
   *
   * Steps: re-check availability → fresh session → put each game on the site's Merkliste (which only accepts ids from
   * the session's current result set) → load the order form and check it lists exactly these games, all orderable →
   * submit the form with the freshly rendered token.
   */
  async submitReservationRequest(params: { contact: Contact; ids: string[] }): Promise<ReservationRequestResult> {
    const contact = ContactSchema.parse(params.contact);
    return this.#lock.run(async () => {
      const ids = [...this.#reservationList];
      if (!ids.length) throw new SpieleboxError("RESERVATION_LIST_EMPTY", "The reservation list is empty");
      if ([...ids].sort().join() !== [...params.ids].sort().join()) {
        throw new SpieleboxError("RESERVATION_LIST_CHANGED", "The reservation list differs from the confirmed games");
      }
      for (const id of ids) this.#details.delete(id);
      const { games, notFound } = await this.#getGames(ids);
      if (notFound.length) {
        throw new SpieleboxError("NOT_FOUND", `Games not found anymore: ${notFound.map((n) => n.id).join(", ")}`);
      }
      const unavailable = games.filter((g) => g.availability !== "available").map((g) => g.title);
      if (unavailable.length) {
        throw new SpieleboxError("NOT_AVAILABLE", `Not available right now: ${unavailable.join(", ")}`);
      }

      this.#http.resetSession();
      const { groups, unknown } = this.#groupByLocator(ids);
      if (unknown.length) throw new SpieleboxError("NOT_FOUND", `Unknown games: ${unknown.join(", ")}`);
      for (const { locator, ids: groupIds } of groups) {
        await this.#enterLocatorResultSet(locator);
        for (const id of groupIds) await this.#http.get({ basket: "add", media: id });
      }

      const form = parseOrderForm(loadPage(await this.#http.get({ orderbasket: "true" })));
      const expected = games.map((g) => g.title).sort();
      const listed = form.items.map((i) => i.title).sort();
      if (JSON.stringify(expected) !== JSON.stringify(listed)) {
        await this.#http.get({ deletebasket: "1" });
        throw new SpieleboxError(
          "ORDER_MISMATCH",
          `The order form lists [${listed.join(", ")}] instead of [${expected.join(", ")}]; nothing was sent`,
        );
      }
      const blocked = form.items.filter((i) => !i.orderable).map((i) => i.title);
      if (blocked.length) {
        await this.#http.get({ deletebasket: "1" });
        throw new SpieleboxError("NOT_ORDERABLE", `The catalog can't reserve: ${blocked.join(", ")}; nothing was sent`);
      }

      const response = parseOrderResponse(
        loadPage(
          await this.#http.post(
            { orderbasket: "true" },
            {
              location: "sb",
              order: form.token,
              firstname: contact.firstName,
              lastname: contact.lastName,
              email: contact.email,
              phone: contact.phone ?? "",
              agb: "ja",
            },
          ),
        ),
      );
      if (!response.accepted)
        throw new SpieleboxError("ORDER_REJECTED", `The catalog rejected the request: ${response.message}`);

      this.#reservationList.clear();
      this.#pinnedLocators.clear();
      return {
        status: "sent",
        titles: expected,
        message: response.message,
        sentAt: new Date(this.#now()).toISOString(),
      };
    });
  }

  async #describeReservationList(notFound: ReservationList["notFound"]): Promise<ReservationList> {
    const ids = [...this.#reservationList];
    const details = ids.length ? await this.#getGames(ids) : { games: [], notFound: [] };
    const items = details.games.map(({ id, title, availability, availableCopies, onlineReservationRequired }) => ({
      id,
      title,
      availability,
      availableCopies,
      onlineReservationRequired,
    }));
    return { items, notFound: [...notFound, ...details.notFound], asOf: new Date(this.#now()).toISOString() };
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
    const key = resultSetKey(locator, query.cwid);
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
    const page = await this.#fetchResults(
      query,
      resultSetKey({ kind: "search", term }),
      { kind: "search", term },
      term,
    );
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
    const { groups, unknown } = this.#groupByLocator([...pending.filter((i) => !inSession.has(i)), ...retry]);
    for (const id of unknown) notFound.push({ id, reason: "Unknown id: search for the game first" });
    for (const { locator, ids: groupIds } of groups) {
      await this.#enterLocatorResultSet(locator);
      for (const id of groupIds) {
        const game = await this.#fetchDetail(id);
        if (game) found.set(id, game);
        else notFound.push({ id, reason: "Not found in the catalog anymore" });
      }
    }

    const games = ids.flatMap((id) => found.get(id) ?? []);
    return { games, notFound };
  }

  /** Groups ids by the search that can bring them back into the session's result set. */
  #groupByLocator(ids: string[]): { groups: { locator: Locator; ids: string[] }[]; unknown: string[] } {
    const groups = new Map<string, { locator: Locator; ids: string[] }>();
    const unknown: string[] = [];
    for (const id of ids) {
      const locator = this.#pinnedLocators.get(id) ?? this.#locators.get(id);
      if (!locator) {
        unknown.push(id);
        continue;
      }
      const key = resultSetKey(locator);
      const group = groups.get(key) ?? { locator, ids: [] };
      group.ids.push(id);
      groups.set(key, group);
    }
    return { groups: [...groups.values()], unknown };
  }

  /** Runs the plain search a locator stands for, making its games the session's result set. */
  async #enterLocatorResultSet(locator: Locator): Promise<void> {
    const term = locator.kind === "new" ? "neue Medien" : locator.term;
    await this.#fetchResults(locatorQuery(locator), resultSetKey(locator), locator, term);
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
