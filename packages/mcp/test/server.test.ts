import { type SearchResult, SpieleboxClient, SpieleboxError, TooManyResultsError } from "@janpaepke/spielebox-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOpac } from "../../client/test/fake-opac.ts";
import { ConfirmationPages, ConsentGate, FormConsentChannel, UrlConsentChannel } from "../src/consent/index.ts";
import { HandoffPages } from "../src/handoff/pages.ts";
import { type CatalogClient, createServer, type ServerOptions } from "../src/server.ts";
import { UpdateCheck } from "../src/updates.ts";

type ElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, string | boolean> };
type ElicitParams = { mode?: "form" | "url"; message: string; requestedSchema?: unknown; url?: string };
type ElicitHandler = (params: ElicitParams) => Promise<ElicitAnswer>;

let pages: ConfirmationPages;
afterEach(() => pages?.close());

/** A consent gate like the production one: form first, local confirmation page as fallback. */
function gate(waitMs = 5000): ConsentGate {
  pages = new ConfirmationPages();
  return new ConsentGate({ channels: [new FormConsentChannel(), new UrlConsentChannel(pages, { waitMs })] });
}

async function connect(
  catalog: CatalogClient,
  {
    options = { consent: gate() },
    elicit,
    modes = { form: {} },
    manual,
  }: {
    options?: ServerOptions;
    elicit?: ElicitHandler;
    modes?: { form?: Record<string, never>; url?: Record<string, never> };
    manual?: boolean;
  } = {},
): Promise<Client> {
  const handler = createMcpHandler(() => createServer(catalog, options));
  const transport = new StreamableHTTPClientTransport(new URL("http://spielebox.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "test", version: "0" },
    {
      versionNegotiation: { mode: "auto" },
      ...(manual && { inputRequired: { autoFulfill: false } }),
      ...(elicit && { capabilities: { elicitation: modes } }),
    },
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (request) => elicit(request.params as ElicitParams));
  }
  await client.connect(transport);
  return client;
}

const EMPTY: SearchResult = { total: 0, offset: 0, games: [], asOf: "2026-10-11T12:00:00.000Z" };
const EMPTY_LIST = { items: [], notFound: [], asOf: "2026-10-11T12:00:00.000Z" };
const SENT = {
  status: "sent" as const,
  titles: ["CATAN Connect"],
  message: "Danke",
  sentAt: "2026-10-11T12:00:00.000Z",
};

function stub(overrides: Partial<CatalogClient> = {}): CatalogClient {
  return {
    search: vi.fn(async () => EMPTY),
    getGames: vi.fn(async () => ({ games: [], notFound: [] })),
    getFilters: vi.fn(async (term: string) => ({
      term,
      total: 0,
      keywords: [],
      players: [],
      ageFrom: [],
      duration: [],
      years: [],
    })),
    newGames: vi.fn(async () => EMPTY),
    addToReservationList: vi.fn(async () => EMPTY_LIST),
    removeFromReservationList: vi.fn(async () => EMPTY_LIST),
    clearReservationList: vi.fn(async () => EMPTY_LIST),
    getReservationList: vi.fn(async () => EMPTY_LIST),
    prepareReservationRequest: vi.fn(async () => EMPTY_LIST),
    planOrderFormHandoff: vi.fn(async () => ({ items: [], steps: [] })),
    submitReservationRequest: vi.fn(async () => SENT),
    ...overrides,
  };
}

describe("spielebox MCP server", () => {
  it("lists the tools with schemas and annotations", async () => {
    const mcp = await connect(stub());
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_games",
      "list_filters",
      "list_new_games",
      "reservation_list_add",
      "reservation_list_clear",
      "reservation_list_remove",
      "reservation_list_show",
      "search_games",
      "submit_reservation_request",
    ]);
    const writing = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
    expect(writing.sort()).toEqual([
      "reservation_list_add",
      "reservation_list_clear",
      "reservation_list_remove",
      "submit_reservation_request",
    ]);
    const submit = tools.find((t) => t.name === "submit_reservation_request");
    expect(submit?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(submit?._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(tools.find((t) => t.name === "reservation_list_clear")?.annotations?.destructiveHint).toBe(true);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect((tool.description ?? "").length).toBeLessThan(2048);
    }
    const search = tools.find((t) => t.name === "search_games");
    expect(search?.inputSchema.required).toEqual(["term"]);
  });

  it("only offers reservation requests with a consent gate", async () => {
    const mcp = await connect(stub(), { options: {} });
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).not.toContain("submit_reservation_request");
  });

  it("passes an update notice along once, without touching the structured result", async () => {
    const updates = new UpdateCheck({
      currentVersion: "0.4.0",
      repository: "x/y",
      howToUpdate: "Get it:",
      fetch: async () => new Response(JSON.stringify({ tag_name: "v0.5.0", html_url: "https://example.org/r" })),
    });
    const mcp = await connect(stub(), { options: { updates } });
    const first = await mcp.callTool({ name: "search_games", arguments: { term: "catan" } });
    await new Promise((r) => setTimeout(r, 0));
    const second = await mcp.callTool({ name: "search_games", arguments: { term: "catan" } });
    const third = await mcp.callTool({ name: "search_games", arguments: { term: "catan" } });
    const texts = (r: typeof first) => (r.content as { text: string }[]).map((c) => c.text);
    const notices = [first, second, third].flatMap(texts).filter((t) => t.startsWith("Update available"));
    expect(notices).toEqual([
      "Update available: spielebox-mcp 0.5.0 (installed: 0.4.0). Get it: https://example.org/r",
    ]);
    expect(second.structuredContent).toEqual(EMPTY);
  });

  it("relays arguments to the client and returns structured content", async () => {
    const catalog = stub();
    const mcp = await connect(catalog);
    const result = await mcp.callTool({ name: "search_games", arguments: { term: "catan", players: 4 } });
    expect(catalog.search).toHaveBeenCalledWith(expect.objectContaining({ term: "catan", players: 4, limit: 20 }));
    expect(result.structuredContent).toEqual(EMPTY);
    expect(result.isError).toBeFalsy();
  });

  it("turns client errors into tool errors", async () => {
    const mcp = await connect(stub({ search: async () => Promise.reject(new TooManyResultsError("spiel")) }));
    const result = await mcp.callTool({ name: "search_games", arguments: { term: "spiel" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("TOO_MANY_RESULTS");
  });

  it("rejects invalid arguments before calling the client", async () => {
    const catalog = stub();
    const mcp = await connect(catalog);
    const result = await mcp.callTool({ name: "search_games", arguments: { term: "ab" } });
    expect(result.isError).toBe(true);
    expect(catalog.search).not.toHaveBeenCalled();
  });

  it("manages the reservation list end to end", async () => {
    const opac = new FakeOpac();
    const mcp = await connect(new SpieleboxClient({ fetch: opac.fetch, minIntervalMs: 0 }));
    const search = await mcp.callTool({ name: "search_games", arguments: { term: "catan", limit: 2 } });
    const ids = (search.structuredContent as SearchResult).games.map((g) => g.id);
    await mcp.callTool({ name: "reservation_list_add", arguments: { ids } });
    await mcp.callTool({ name: "reservation_list_remove", arguments: { ids: [ids[0]] } });
    const shown = await mcp.callTool({ name: "reservation_list_show", arguments: {} });
    expect(shown.structuredContent).toMatchObject({ items: [{ id: ids[1] }], notFound: [] });
    const cleared = await mcp.callTool({ name: "reservation_list_clear", arguments: {} });
    expect(cleared.structuredContent).toMatchObject({ items: [] });
  });

  it("works end to end with the real client", async () => {
    const opac = new FakeOpac();
    const mcp = await connect(new SpieleboxClient({ fetch: opac.fetch, minIntervalMs: 0 }));
    const search = await mcp.callTool({ name: "search_games", arguments: { term: "catan", limit: 3 } });
    const games = (search.structuredContent as SearchResult).games;
    expect(games).toHaveLength(3);
    const details = await mcp.callTool({ name: "get_games", arguments: { ids: [games[0]?.id] } });
    expect(details.isError).toBeFalsy();
    expect(details.structuredContent).toMatchObject({ games: [{ title: games[0]?.title }], notFound: [] });
  });
});

describe("submit_reservation_request", () => {
  const LISTED = {
    items: [
      {
        id: "3375ddafbc45fed35c0da0b4cc481084",
        title: "CATAN Connect",
        availability: "available" as const,
        availableCopies: 2,
        onlineReservationRequired: false,
      },
    ],
    notFound: [],
    asOf: "2026-10-11T12:00:00.000Z",
  };
  const contact = { firstName: "Erika", lastName: "Muster", email: "erika@example.org", phone: "+43 1 234" };
  const listed = () =>
    stub({ prepareReservationRequest: vi.fn(async () => LISTED), getReservationList: vi.fn(async () => LISTED) });
  const call = (mcp: Client) => mcp.callTool({ name: "submit_reservation_request", arguments: {} });

  it("asks the user with the exact games and the order form's wording, then submits what they confirmed", async () => {
    const catalog = listed();
    const prompts: ElicitParams[] = [];
    const mcp = await connect(catalog, {
      options: { consent: gate(), contact: { firstName: "Erika", email: "erika@example.org" } },
      elicit: async (params) => {
        prompts.push(params);
        return { action: "accept", content: { ...contact, confirm: true } };
      },
    });
    const result = await call(mcp);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sent: true, request: SENT });
    expect(catalog.submitReservationRequest).toHaveBeenCalledWith({
      contact,
      ids: ["3375ddafbc45fed35c0da0b4cc481084"],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.message).toContain("• CATAN Connect");
    expect(prompts[0]?.message).toContain("Zusendung von Informationen über Angebote des Vereins wienXtra");
    expect(JSON.stringify(prompts[0]?.requestedSchema)).toContain('"default":"Erika"');
  });

  it.each([
    ["declines", { action: "decline" as const }],
    ["cancels", { action: "cancel" as const }],
    ["accepts without ticking the box", { action: "accept" as const, content: { ...contact, confirm: false } }],
  ])("sends nothing when the user %s", async (_, answer) => {
    const catalog = listed();
    const mcp = await connect(catalog, { elicit: async () => answer });
    const result = await call(mcp);
    expect(JSON.stringify(result.content)).toContain("Nothing was sent");
    expect(result.structuredContent).toMatchObject({ sent: false });
    expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
  });

  it("refuses clients that can't show a form", async () => {
    const catalog = listed();
    const mcp = await connect(catalog);
    const outcome = await call(mcp).catch((error: unknown) => ({ isError: true, error }));
    expect(outcome.isError).toBe(true);
    expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
  });

  it("passes the confirmed games, so the client can refuse if the list changed meanwhile", async () => {
    const catalog = listed();
    catalog.submitReservationRequest = vi.fn(async () =>
      Promise.reject(new SpieleboxError("RESERVATION_LIST_CHANGED", "changed")),
    );
    const mcp = await connect(catalog, {
      elicit: async () => ({ action: "accept", content: { ...contact, confirm: true } }),
    });
    const result = await call(mcp);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("RESERVATION_LIST_CHANGED");
  });

  it("reports catalog errors while preparing as tool errors", async () => {
    const mcp = await connect(
      stub({ prepareReservationRequest: vi.fn(async () => Promise.reject(new SpieleboxError("HTTP", "down"))) }),
      { elicit: vi.fn<ElicitHandler>() },
    );
    expect(JSON.stringify((await call(mcp)).content)).toContain("HTTP: down");
  });

  it("rejects invalid contact data from the form", async () => {
    const catalog = listed();
    const mcp = await connect(catalog, {
      elicit: async () => ({ action: "accept", content: { ...contact, email: "nope", confirm: true } }),
    });
    expect((await call(mcp)).structuredContent).toMatchObject({
      sent: false,
      reason: expect.stringMatching(/contact/),
    });
    expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
  });

  it("reserves end to end against the fake catalog", async () => {
    const opac = new FakeOpac();
    const mcp = await connect(new SpieleboxClient({ fetch: opac.fetch, minIntervalMs: 0 }), {
      elicit: async () => ({ action: "accept", content: { ...contact, confirm: true } }),
    });
    const search = await mcp.callTool({ name: "search_games", arguments: { term: "catan connect" } });
    const [game] = (search.structuredContent as SearchResult).games;
    await mcp.callTool({ name: "reservation_list_add", arguments: { ids: [game?.id] } });
    const result = await call(mcp);
    expect(result.structuredContent).toMatchObject({ sent: true, request: { titles: ["CATAN Connect"] } });
    expect(opac.orders).toHaveLength(1);
    expect(opac.orders[0]?.get("email")).toBe(contact.email);
  });

  describe("in a client without forms (URL mode, e.g. Claude Desktop)", () => {
    /** Plays the user in the browser: opens the page and submits it, shortly after the client returned. */
    const browser = (fields: Record<string, string>) => async (params: ElicitParams) => {
      expect(params.mode).toBe("url");
      const url = params.url ?? "";
      setTimeout(async () => {
        const page = await fetch(url);
        expect(await page.text()).toContain("CATAN Connect");
        await fetch(url, {
          method: "POST",
          headers: { origin: new URL(url).origin, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields),
        });
      }, 20);
      return { action: "accept" as const };
    };

    it("waits for the confirmation page and submits what was entered there", async () => {
      const catalog = listed();
      const mcp = await connect(catalog, {
        modes: { url: {} },
        elicit: browser({ ...contact, confirm: "yes", action: "confirm" }),
      });
      const result = await call(mcp);
      expect(result.structuredContent).toEqual({ sent: true, request: SENT });
      expect(catalog.submitReservationRequest).toHaveBeenCalledWith({ contact, ids: [LISTED.items[0]?.id] });
    });

    it("sends nothing when the user cancels on the page", async () => {
      const catalog = listed();
      const mcp = await connect(catalog, { modes: { url: {} }, elicit: browser({ action: "decline" }) });
      expect((await call(mcp)).structuredContent).toMatchObject({ sent: false });
      expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
    });

    it("sends nothing when the user doesn't open the page", async () => {
      const catalog = listed();
      const mcp = await connect(catalog, { modes: { url: {} }, elicit: async () => ({ action: "decline" }) });
      expect((await call(mcp)).structuredContent).toMatchObject({ sent: false });
      expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
    });

    it("gives up when the page isn't answered in time", async () => {
      const catalog = listed();
      const mcp = await connect(catalog, {
        options: { consent: gate(50) },
        modes: { url: {} },
        elicit: async () => ({ action: "accept" }),
      });
      expect((await call(mcp)).structuredContent).toMatchObject({
        sent: false,
        reason: expect.stringMatching(/in time/),
      });
      expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
    });

    it("prefers the form when the client supports both", async () => {
      const elicit = vi.fn<ElicitHandler>(async () => ({ action: "decline" }));
      await call(await connect(listed(), { modes: { form: {}, url: {} }, elicit }));
      expect(elicit.mock.calls[0]?.[0]).not.toHaveProperty("url");
    });
  });

  describe("against a misbehaving client", () => {
    const accept = { action: "accept", content: { ...contact, confirm: true } };
    async function confirmedRound(mcp: Client) {
      const first = (await mcp.callTool(
        { name: "submit_reservation_request", arguments: {} },
        { allowInputRequired: true },
      )) as { resultType?: string; requestState?: string };
      expect(first.resultType).toBe("input_required");
      return { inputResponses: { consent: accept }, requestState: first.requestState ?? "" };
    }

    it("accepts a confirmation only once", async () => {
      const catalog = listed();
      const mcp = await connect(catalog, { elicit: async () => accept as ElicitAnswer, manual: true });
      const round = await confirmedRound(mcp);
      const retry = { name: "submit_reservation_request", arguments: {}, ...round };
      expect((await mcp.callTool(retry)).structuredContent).toMatchObject({ sent: true });
      const replay = await mcp.callTool(retry);
      expect(replay.isError).toBe(true);
      expect(catalog.submitReservationRequest).toHaveBeenCalledTimes(1);
    });

    it("rejects a forged confirmation state", async () => {
      const catalog = listed();
      const mcp = await connect(catalog, { elicit: async () => accept as ElicitAnswer, manual: true });
      const round = await confirmedRound(mcp);
      const forged = { ...round, requestState: `${round.requestState.slice(0, -4)}AAAA` };
      await expect(mcp.callTool({ name: "submit_reservation_request", arguments: {}, ...forged })).rejects.toThrow();
      expect(catalog.submitReservationRequest).not.toHaveBeenCalled();
    });
  });

  it("doesn't ask when there is nothing to reserve or a game is unavailable", async () => {
    const elicit = vi.fn<ElicitHandler>();
    const empty = await connect(stub(), { elicit });
    expect((await call(empty)).isError).toBe(true);
    const [item] = LISTED.items;
    if (!item) throw new Error("fixture");
    const borrowed = { ...LISTED, items: [{ ...item, availability: "borrowed" as const, availableCopies: 0 }] };
    const unavailable = await connect(stub({ prepareReservationRequest: vi.fn(async () => borrowed) }), { elicit });
    expect(JSON.stringify((await call(unavailable)).content)).toContain("Not available right now: CATAN Connect");
    expect(elicit).not.toHaveBeenCalled();
  });
});

describe("open_order_form", () => {
  let handoffPages: HandoffPages;
  afterEach(() => handoffPages?.close());

  function withHandoff(catalog: CatalogClient) {
    handoffPages = new HandoffPages();
    const opened: string[] = [];
    const options = {
      consent: gate(),
      contact: { firstName: "Erika" },
      handoff: { pages: handoffPages, openBrowser: (url: string) => void opened.push(url) },
    };
    return { options, opened, connect: () => connect(catalog, { options }) };
  }

  it("is only offered with a handoff, and isn't destructive", async () => {
    expect((await (await connect(stub())).listTools()).tools.map((t) => t.name)).not.toContain("open_order_form");
    const { tools } = await (await withHandoff(stub()).connect()).listTools();
    expect(tools.find((t) => t.name === "open_order_form")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("opens a handoff page for the planned steps in the browser", async () => {
    const plan = {
      items: [
        {
          id: "a".repeat(32),
          title: "CATAN Connect",
          availability: "available" as const,
          availableCopies: 2,
          onlineReservationRequired: false,
        },
      ],
      steps: [{ kind: "form" as const, url: "https://opac.wienxtra.at/index.php?orderbasket=true&location=sb" }],
    };
    const setup = withHandoff(stub({ planOrderFormHandoff: vi.fn(async () => plan) }));
    const result = await (await setup.connect()).callTool({ name: "open_order_form", arguments: {} });
    const { url } = result.structuredContent as { url: string };
    expect(setup.opened).toEqual([url]);
    const html = await (await fetch(url)).text();
    expect(html).toContain("<li>CATAN Connect</li>");
    expect(html).not.toContain("Erika");
  });

  it("reports catalog refusals as tool errors and opens nothing", async () => {
    const setup = withHandoff(
      stub({ planOrderFormHandoff: async () => Promise.reject(new SpieleboxError("RESERVATION_LIST_EMPTY", "empty")) }),
    );
    const result = await (await setup.connect()).callTool({ name: "open_order_form", arguments: {} });
    expect(result.isError).toBe(true);
    expect(setup.opened).toEqual([]);
  });

  it("is where submit_reservation_request points clients without confirmations", async () => {
    const result = await (await withHandoff(stub()).connect()).callTool({
      name: "submit_reservation_request",
      arguments: {},
    });
    expect(JSON.stringify(result.content)).toContain("open_order_form");
  });

  it("plans against the fake catalog end to end", async () => {
    const opac = new FakeOpac();
    const setup = withHandoff(new SpieleboxClient({ fetch: opac.fetch, minIntervalMs: 0 }));
    const mcp = await setup.connect();
    const search = await mcp.callTool({ name: "search_games", arguments: { term: "catan connect" } });
    const [game] = (search.structuredContent as SearchResult).games;
    await mcp.callTool({ name: "reservation_list_add", arguments: { ids: [game?.id] } });
    const opened = await mcp.callTool({ name: "open_order_form", arguments: {} });
    const html = await (await fetch((opened.structuredContent as { url: string }).url)).text();
    expect(html).toContain("deletebasket=1");
    expect(html).toContain(`basket=add&media=${game?.id}`);
    expect(
      opac.log.some((l) => l.startsWith("basket=") || l.startsWith("orderbasket") || l.startsWith("deletebasket")),
    ).toBe(false);
  });
});
