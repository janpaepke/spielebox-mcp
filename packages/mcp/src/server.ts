import {
  type Contact,
  Filters,
  GetGamesParams,
  GetGamesResult,
  NewGamesParams,
  ReservationList,
  ReservationListChange,
  ReservationRequestResult,
  SearchParams,
  SearchResult,
  type SpieleboxClient,
  SpieleboxError,
} from "@janpaepke/spielebox-client";
import { type CallToolResult, type InputRequiredResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import { type ConsentGate, elicitationModes } from "./consent/gate.ts";
import type { UpdateCheck } from "./updates.ts";

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
  | "prepareReservationRequest"
  | "submitReservationRequest"
>;

export type ServerOptions = {
  /**
   * Obtains the user's consent for reservation requests. Must be shared by all server instances of a process.
   * Without it, `submit_reservation_request` isn't offered.
   */
  consent?: ConsentGate;
  /** Defaults for the contact fields shown in the consent step (e.g. from env). */
  contact?: Partial<Contact>;
  /** Tells the user once per process when a newer release exists. Must be shared by all server instances. */
  updates?: UpdateCheck;
};

const INSTRUCTIONS = `Unofficial tools (not affiliated with WIENXTRA) for the WIENXTRA-Spielebox in Vienna, Austria's largest board game library (~9000 games, lent for free or a small fee).
Catalog data is German. Typical flow: search_games (or list_new_games) → get_games for per-copy availability.
- Search terms match as a contiguous substring of title, author, description and keywords. No AND/OR or wildcards: search one distinctive word or the exact title fragment ("flügelschlag", "die siedler").
- Filter with players/age/maxDuration/availableOnly; use list_filters to discover keywords like "Kooperationsspiele" or "ausgezeichnet" (award-winning).
- Availability changes often; every result has an asOf time. Game ids are only valid for this server instance after a search found them.
- onlineReservationRequired: the game must be reserved online before pickup.
- The reservation list stages games for a reservation request (the catalog's "Merkliste"); it lives in this server's memory.
- If a tool result contains an "Update available" note, pass it on to the user once.
- submit_reservation_request sends the list to the Spielebox. It is binding for the user, so it always asks the user to confirm (in a form, or on a page in the browser); never call it without the user asking for it. Success means "request sent": the staff confirm by e-mail when the games are ready.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Changes only the in-memory reservation list, never the catalog. */
const LOCAL_CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Result of submit_reservation_request: either the request was sent, or why nothing was sent. */
const SubmitOutcome = z.object({
  sent: z.boolean(),
  reason: z.string().optional().describe("Why nothing was sent (user declined, didn't confirm, …)"),
  request: ReservationRequestResult.optional(),
});

/** Builds the MCP server. Each tool validates with the client's schemas and relays to one client method. */
export function createServer(client: CatalogClient, options: ServerOptions = {}): McpServer {
  const { consent, contact = {}, updates } = options;

  /** Relays a client call; the first call also starts the update check, and a pending update notice rides along once. */
  const relay = async <T extends Record<string, unknown>>(call: () => Promise<T>): Promise<CallToolResult> => {
    updates?.start();
    const result = await toResult(call);
    const notice = await updates?.takeNotice();
    return notice ? { ...result, content: [...result.content, { type: "text", text: notice }] } : result;
  };
  const server = new McpServer(
    { name: "spielebox", version: pkg.version },
    { instructions: INSTRUCTIONS, ...(consent && { requestState: { verify: consent.verify } }) },
  );

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

  if (!consent) return server;

  server.registerTool(
    "submit_reservation_request",
    {
      title: "Submit reservation request",
      description:
        "Send the reservation list to the Spielebox as a binding reservation request. Always asks the user to confirm first " +
        "(games, contact data), in a form or on a page in the browser; nothing is sent without their explicit confirmation. " +
        "Only call when the user asks to reserve.",
      inputSchema: z.object({}),
      outputSchema: SubmitOutcome,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
      const supported = elicitationModes(ctx, server.server.getClientCapabilities());
      const round = await consent.run(ctx, supported, async () => {
        let list: ReservationList;
        try {
          list = await client.prepareReservationRequest();
        } catch (error) {
          return { stop: errorResult(error) };
        }
        if (!list.items.length) {
          return { stop: toolError("The reservation list is empty; add games with reservation_list_add first.") };
        }
        const unavailable = list.items.filter((i) => i.availability !== "available");
        if (unavailable.length) {
          const titles = unavailable.map((i) => i.title).join(", ");
          return {
            stop: toolError(`Not available right now: ${titles}. Remove them from the reservation list first.`),
          };
        }
        return { ask: { ids: list.items.map((i) => i.id), titles: list.items.map((i) => i.title), contact } };
      });
      if (round.status !== "decided") return round.result;
      if (!round.outcome.granted) return notSent(round.outcome.reason);
      const confirmed = round.outcome.contact;
      // The client sends only if the list is still exactly what the user confirmed (checked atomically).
      return relay(async () => ({
        sent: true,
        request: await client.submitReservationRequest({ contact: confirmed, ids: round.ids }),
      }));
    },
  );

  return server;
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function notSent(reason: string): CallToolResult {
  const outcome = { sent: false, reason };
  return { content: [{ type: "text", text: `Nothing was sent. ${reason}` }], structuredContent: outcome };
}

/** Turns a client result into structured tool output, and client errors into tool errors the model can act on. */
async function toResult<T extends Record<string, unknown>>(call: () => Promise<T>): Promise<CallToolResult> {
  try {
    const result = await call();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    return errorResult(error);
  }
}

/** Client errors become tool errors carrying the error code; anything else is a bug and propagates. */
function errorResult(error: unknown): CallToolResult {
  if (!(error instanceof SpieleboxError) && !(error instanceof z.ZodError)) throw error;
  return toolError(error instanceof SpieleboxError ? `${error.code}: ${error.message}` : z.prettifyError(error));
}
