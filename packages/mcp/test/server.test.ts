import { type SearchResult, SpieleboxClient, TooManyResultsError } from "@janpaepke/spielebox-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { FakeOpac } from "../../client/test/fake-opac.ts";
import { type CatalogClient, createServer } from "../src/server.ts";

async function connect(catalog: CatalogClient): Promise<Client> {
  const handler = createMcpHandler(() => createServer(catalog));
  const transport = new StreamableHTTPClientTransport(new URL("http://spielebox.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const EMPTY: SearchResult = { total: 0, offset: 0, games: [], asOf: "2026-10-11T12:00:00.000Z" };

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
    ...overrides,
  };
}

describe("spielebox MCP server", () => {
  it("lists the read-only tools with schemas and annotations", async () => {
    const mcp = await connect(stub());
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_games", "list_filters", "list_new_games", "search_games"]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
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
