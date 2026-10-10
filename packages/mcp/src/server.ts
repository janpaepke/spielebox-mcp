import {
  Filters,
  GetGamesParams,
  GetGamesResult,
  NewGamesParams,
  ReservationList,
  ReservationListChange,
  SearchParams,
  SearchResult,
  type SpieleboxClient,
  SpieleboxError,
} from "@janpaepke/spielebox-client";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };

/** The client methods the server relays to. */
export type CatalogClient = Pick<
  SpieleboxClient,
  | "search"
  | "getGames"
  | "getFilters"
  | "newGames"
  | "addToReservationList"
  | "removeFromReservationList"
  | "clearReservationList"
  | "getReservationList"
>;

const INSTRUCTIONS = `Tools for the WIENXTRA-Spielebox in Vienna, Austria's largest board game library (~9000 games, lent for free or a small fee).
Catalog data is German. Typical flow: search_games (or list_new_games) → get_games for per-copy availability.
- Search terms match as a contiguous substring of title, author, description and keywords. No AND/OR or wildcards: search one distinctive word or the exact title fragment ("flügelschlag", "die siedler").
- Filter with players/age/maxDuration/availableOnly; use list_filters to discover keywords like "Kooperationsspiele" or "ausgezeichnet" (award-winning).
- Availability changes often; every result has an asOf time. Game ids are only valid for this server instance after a search found them.
- onlineReservationRequired: the game must be reserved online before pickup.
- The reservation list stages games for a reservation request (the catalog's "Merkliste"); it lives in this server's memory. Submitting a reservation request isn't supported yet: the user has to reserve on https://opac.wienxtra.at/?location=sb.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Changes only the in-memory reservation list, never the catalog. */
const LOCAL_CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Builds the MCP server. Each tool validates with the client's schemas and relays to one client method. */
export function createServer(client: CatalogClient): McpServer {
  const server = new McpServer({ name: "spielebox", version: pkg.version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_games",
    {
      title: "Search games",
      description:
        "Search the Spielebox catalog. Returns games with players, age, play time, availability and a shortened description.",
      inputSchema: SearchParams,
      outputSchema: SearchResult,
      annotations: READ_ONLY,
    },
    (params) => relay(() => client.search(params)),
  );

  server.registerTool(
    "get_games",
    {
      title: "Get game details",
      description:
        "Full details for up to 10 games from earlier results: complete description and keywords, exact play time, and availability per copy.",
      inputSchema: GetGamesParams,
      outputSchema: GetGamesResult,
      annotations: READ_ONLY,
    },
    (params) => relay(() => client.getGames(params)),
  );

  server.registerTool(
    "list_filters",
    {
      title: "List filters",
      description:
        "Keywords (Schlagworte), player counts, ages, play times and years occurring in the results for a term, with counts.",
      inputSchema: SearchParams.pick({ term: true }),
      outputSchema: Filters,
      annotations: READ_ONLY,
    },
    ({ term }) => relay(() => client.getFilters(term)),
  );

  server.registerTool(
    "list_new_games",
    {
      title: "List new games",
      description: "Games recently added to the catalog.",
      inputSchema: NewGamesParams,
      outputSchema: SearchResult,
      annotations: READ_ONLY,
    },
    (params) => relay(() => client.newGames(params)),
  );

  server.registerTool(
    "reservation_list_add",
    {
      title: "Add to reservation list",
      description:
        "Stage games for the next reservation request. Ids must come from earlier results. Returns the list with current availability.",
      inputSchema: ReservationListChange,
      outputSchema: ReservationList,
      annotations: { ...LOCAL_CHANGE, openWorldHint: true },
    },
    (params) => relay(() => client.addToReservationList(params)),
  );

  server.registerTool(
    "reservation_list_remove",
    {
      title: "Remove from reservation list",
      description: "Remove games from the reservation list.",
      inputSchema: ReservationListChange,
      outputSchema: ReservationList,
      annotations: LOCAL_CHANGE,
    },
    (params) => relay(() => client.removeFromReservationList(params)),
  );

  server.registerTool(
    "reservation_list_show",
    {
      title: "Show reservation list",
      description: "The games staged for the next reservation request, with current availability.",
      outputSchema: ReservationList,
      annotations: READ_ONLY,
    },
    () => relay(() => client.getReservationList()),
  );

  server.registerTool(
    "reservation_list_clear",
    {
      title: "Clear reservation list",
      description: "Remove all games from the reservation list.",
      outputSchema: ReservationList,
      annotations: { ...LOCAL_CHANGE, destructiveHint: true },
    },
    () => relay(() => client.clearReservationList()),
  );

  return server;
}

/** Turns a client result into structured tool output, and client errors into tool errors the model can act on. */
async function relay<T extends Record<string, unknown>>(call: () => Promise<T>) {
  try {
    const result = await call();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    if (!(error instanceof SpieleboxError) && !(error instanceof z.ZodError)) throw error;
    const text = error instanceof SpieleboxError ? `${error.code}: ${error.message}` : z.prettifyError(error);
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}
