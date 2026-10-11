import { type SearchResult, SpieleboxClient, SpieleboxError, TooManyResultsError } from "@janpaepke/spielebox-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { FakeOpac } from "../../client/test/fake-opac.ts";
import { type CatalogClient, createServer, type ServerOptions } from "../src/server.ts";

type ElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, string | boolean> };
type ElicitHandler = (params: { message: string; requestedSchema: unknown }) => Promise<ElicitAnswer>;

async function connect(
  catalog: CatalogClient,
  { options, elicit, manual }: { options?: ServerOptions; elicit?: ElicitHandler; manual?: boolean } = {},
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
      ...(elicit && { capabilities: { elicitation: { form: {} } } }),
    },
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (request) =>
      elicit(request.params as { message: string; requestedSchema: unknown }),
    );
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
    const prompts: { message: string; requestedSchema: unknown }[] = [];
    const mcp = await connect(catalog, {
      options: { contact: { firstName: "Erika", email: "erika@example.org" } },
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
    expect((await call(mcp)).isError).toBe(true);
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
