import { randomBytes, randomUUID } from "node:crypto";
import {
  Contact,
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
import {
  acceptedContent,
  type CallToolResult,
  createRequestStateCodec,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
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
  | "prepareReservationRequest"
  | "submitReservationRequest"
>;

export type ServerOptions = {
  /** Defaults for the contact fields of the reservation consent form (e.g. from env). */
  contact?: Partial<Contact>;
  /** HMAC key for the consent round trip (≥ 32 bytes). Defaults to a random per-process key; set it when several processes serve one client. */
  stateKey?: Uint8Array;
};

const INSTRUCTIONS = `Tools for the WIENXTRA-Spielebox in Vienna, Austria's largest board game library (~9000 games, lent for free or a small fee).
Catalog data is German. Typical flow: search_games (or list_new_games) → get_games for per-copy availability.
- Search terms match as a contiguous substring of title, author, description and keywords. No AND/OR or wildcards: search one distinctive word or the exact title fragment ("flügelschlag", "die siedler").
- Filter with players/age/maxDuration/availableOnly; use list_filters to discover keywords like "Kooperationsspiele" or "ausgezeichnet" (award-winning).
- Availability changes often; every result has an asOf time. Game ids are only valid for this server instance after a search found them.
- onlineReservationRequired: the game must be reserved online before pickup.
- The reservation list stages games for a reservation request (the catalog's "Merkliste"); it lives in this server's memory.
- submit_reservation_request sends the list to the Spielebox. It is binding for the user, so it always asks the user to confirm in a form; never call it without the user asking for it. Success means "request sent": the staff confirm by e-mail when the games are ready.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Changes only the in-memory reservation list, never the catalog. */
const LOCAL_CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Wording of the checkbox on the catalog's order form; the request is sent with it ticked. */
const ORDER_FORM_CONSENT =
  "Ich stimme bis auf Widerruf der Verwendung meiner bekannt gegebenen Daten zum Zweck der Zusendung von Informationen über Angebote des Vereins wienXtra zu.";

/** Result of submit_reservation_request: either the request was sent, or why nothing was sent. */
const SubmitOutcome = z.object({
  sent: z.boolean(),
  reason: z.string().optional().describe("Why nothing was sent (user declined, didn't confirm, …)"),
  request: ReservationRequestResult.optional(),
});

/** What the consent round trip carries: the games the user was shown, and a single-use nonce. Signed, no personal data. */
type ConsentState = { ids: string[]; nonce: string };

/**
 * Process-wide, because the SDK may build a server instance per request (stateless protocol): the consent round trip
 * spans two requests, so its key and the record of used nonces must outlive any single instance.
 */
const PROCESS_STATE_KEY = randomBytes(32);
const usedNonces = new Map<string, number>();

/** Builds the MCP server. Each tool validates with the client's schemas and relays to one client method. */
export function createServer(client: CatalogClient, options: ServerOptions = {}): McpServer {
  const stateCodec = createRequestStateCodec<ConsentState>({
    key: options.stateKey ?? PROCESS_STATE_KEY,
    ttlSeconds: 300,
    bind: (ctx) => ctx.mcpReq.method,
  });
  const server = new McpServer(
    { name: "spielebox", version: pkg.version },
    { instructions: INSTRUCTIONS, requestState: { verify: stateCodec.verify } },
  );
  const consentForm = consentFormSchema(options.contact ?? {});

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

  server.registerTool(
    "submit_reservation_request",
    {
      title: "Submit reservation request",
      description:
        "Send the reservation list to the Spielebox as a binding reservation request. Always shows the user a confirmation form " +
        "(games, contact data) first; nothing is sent without their explicit confirmation. Only call when the user asks to reserve.",
      inputSchema: z.object({}),
      outputSchema: SubmitOutcome,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
      const state = ctx.mcpReq.requestState<ConsentState>();
      const answer = inputResponse(ctx.mcpReq.inputResponses, "consent");

      // Round 1: show the user exactly what would be sent and ask for confirmation.
      if (!state || answer.kind !== "elicit") {
        let list: ReservationList;
        try {
          list = await client.prepareReservationRequest();
        } catch (error) {
          return errorResult(error);
        }
        if (!list.items.length)
          return toolError("The reservation list is empty; add games with reservation_list_add first.");
        const unavailable = list.items.filter((i) => i.availability !== "available");
        if (unavailable.length) {
          return toolError(
            `Not available right now: ${unavailable.map((i) => i.title).join(", ")}. Remove them from the reservation list first.`,
          );
        }
        const titles = list.items.map((i) => `• ${i.title}`).join("\n");
        return inputRequired({
          inputRequests: {
            consent: inputRequired.elicit({
              message:
                `Verbindliche Vorbestellung bei der WIENXTRA-Spielebox:\n${titles}\n\n` +
                "Die Spielebox bestätigt per E-Mail, wenn die Spiele bereit sind. Bestellung mindestens einen Tag vor der " +
                "Abholung; abholen innerhalb weniger Werktage.\n\n" +
                `Mit dem Absenden wird im Formular der Spielebox bestätigt: „${ORDER_FORM_CONSENT}“`,
              requestedSchema: consentForm,
            }),
          },
          requestState: await stateCodec.mint({ ids: list.items.map((i) => i.id), nonce: randomUUID() }, ctx),
        });
      }

      // Round 2: the state is verified (signature, expiry) by the SDK before we get here.
      const now = Date.now();
      for (const [nonce, expires] of usedNonces) if (expires < now) usedNonces.delete(nonce);
      if (usedNonces.has(state.nonce)) return toolError("This confirmation was already used; call the tool again.");
      usedNonces.set(state.nonce, now + 10 * 60_000);

      if (answer.action !== "accept")
        return notSent(`The user ${answer.action === "decline" ? "declined" : "cancelled"}.`);
      const consent = acceptedContent(ctx.mcpReq.inputResponses, "consent", consentForm);
      if (!consent?.confirm) return notSent("The user did not tick the confirmation box.");

      const contact = Contact.safeParse({
        firstName: consent.firstName,
        lastName: consent.lastName,
        email: consent.email,
        phone: consent.phone || undefined,
      });
      if (!contact.success)
        return toolError(`Invalid contact data, nothing was sent: ${z.prettifyError(contact.error)}`);
      return relay(async () => ({
        sent: true,
        // The client sends only if the list is still exactly what the user confirmed (checked atomically).
        request: await client.submitReservationRequest({ contact: contact.data, ids: state.ids }),
      }));
    },
  );

  return server;
}

/** The consent form: a required confirmation plus the contact fields of the catalog's order form, prefilled. */
function consentFormSchema(defaults: Partial<Contact>) {
  const text = (title: string, value: string | undefined) =>
    value ? z.string().meta({ title }).default(value) : z.string().meta({ title });
  return z.object({
    confirm: z.boolean().meta({ title: "Ja, verbindlich vorbestellen" }).default(false),
    firstName: text("Vorname", defaults.firstName),
    lastName: text("Nachname", defaults.lastName),
    email: text("E-Mail", defaults.email),
    phone: text("Telefon (optional)", defaults.phone).optional(),
  });
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function notSent(reason: string): CallToolResult {
  const outcome = { sent: false, reason };
  return { content: [{ type: "text", text: `Nothing was sent. ${reason}` }], structuredContent: outcome };
}

/** Turns a client result into structured tool output, and client errors into tool errors the model can act on. */
async function relay<T extends Record<string, unknown>>(call: () => Promise<T>) {
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
