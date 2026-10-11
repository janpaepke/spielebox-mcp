import { randomBytes, randomUUID } from "node:crypto";
import {
  type CallToolResult,
  createRequestStateCodec,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { ConsentChannel, ConsentOutcome, ConsentRequest } from "./types.ts";

/** Signed state of the consent round trip: no personal data, only what routes and binds the second round. */
type ConsentState = { ids: string[]; titles: string[]; nonce: string; channel: string; ticket?: string };

const ENVELOPE_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

export type ConsentGateOptions = {
  /** Channels in order of preference; the first one the client supports is used. */
  channels: ConsentChannel[];
  /** HMAC key for the round trip (≥ 32 bytes). Defaults to a random key; share it when several processes serve one client. */
  key?: Uint8Array;
  ttlSeconds?: number;
};

export type ConsentResult =
  | { status: "ask"; result: InputRequiredResult }
  | { status: "stopped"; result: CallToolResult }
  | { status: "decided"; ids: string[]; outcome: ConsentOutcome };

/**
 * Obtains the user's explicit consent for one request over two rounds:
 * round 1 picks a channel the client supports and asks; round 2 verifies the signed state (done by the SDK through
 * {@link verify}), enforces single use and lets the channel collect the answer.
 *
 * One gate must serve all server instances of a process: the SDK may build a server per request, while a round trip
 * spans two requests.
 */
export class ConsentGate {
  readonly #channels: ConsentChannel[];
  readonly #codec: ReturnType<typeof createRequestStateCodec<ConsentState>>;
  readonly #usedNonces = new Map<string, number>();
  readonly #ttlMs: number;

  constructor({ channels, key = randomBytes(32), ttlSeconds = 300 }: ConsentGateOptions) {
    this.#channels = channels;
    this.#ttlMs = ttlSeconds * 1000;
    this.#codec = createRequestStateCodec<ConsentState>({ key, ttlSeconds, bind: (ctx) => ctx.mcpReq.method });
  }

  /** For `ServerOptions.requestState.verify`: rejects forged or expired state before any handler runs. */
  get verify() {
    return this.#codec.verify;
  }

  /**
   * Runs one round. `prepare` is only called in round 1; it returns what to ask for, or a tool result to end early
   * (e.g. nothing to reserve).
   */
  async run(
    ctx: ServerContext,
    supported: { form: boolean; url: boolean },
    prepare: () => Promise<{ ask: ConsentRequest } | { stop: CallToolResult }>,
  ): Promise<ConsentResult> {
    const state = ctx.mcpReq.requestState<ConsentState>();
    const answer = inputResponse(ctx.mcpReq.inputResponses, "consent");

    if (!state || answer.kind === "missing") {
      const channel = this.#channels.find((c) => c.supports(supported));
      if (!channel) {
        return stopped(
          "This MCP client can't show a confirmation (no elicitation form or URL support), so nothing can be sent from here. " +
            "Use open_order_form instead: it opens the Spielebox's own order form with the games in the user's browser.",
        );
      }
      const prepared = await prepare();
      if ("stop" in prepared) return { status: "stopped", result: prepared.stop };
      const request = prepared.ask;
      const { input, ticket } = await channel.ask(request);
      const nonce = randomUUID();
      const minted = await this.#codec.mint(
        { ids: request.ids, titles: request.titles, nonce, channel: channel.name, ...(ticket && { ticket }) },
        ctx,
      );
      return { status: "ask", result: inputRequired({ inputRequests: { consent: input }, requestState: minted }) };
    }

    const now = Date.now();
    for (const [nonce, expires] of this.#usedNonces) if (expires < now) this.#usedNonces.delete(nonce);
    if (this.#usedNonces.has(state.nonce)) return stopped("This confirmation was already used; call the tool again.");
    this.#usedNonces.set(state.nonce, now + this.#ttlMs);

    const channel = this.#channels.find((c) => c.name === state.channel);
    if (!channel) return stopped("Unknown confirmation channel; call the tool again.");
    const request = { ids: state.ids, titles: state.titles, contact: {} };
    return { status: "decided", ids: state.ids, outcome: await channel.collect(answer, request, state.ticket) };
  }
}

/** Elicitation modes the client declared, per request (2026-07-28) or from the connection (earlier revisions). */
export function elicitationModes(ctx: ServerContext, connectionCapabilities: unknown): { form: boolean; url: boolean } {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = (envelope?.[ENVELOPE_CAPABILITIES] ?? connectionCapabilities) as
    | { elicitation?: { form?: object; url?: object } }
    | undefined;
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return { form: false, url: false };
  // An empty elicitation capability means form mode (backwards compatibility).
  const empty = !elicitation.form && !elicitation.url;
  return { form: empty || Boolean(elicitation.form), url: Boolean(elicitation.url) };
}

function stopped(text: string): { status: "stopped"; result: CallToolResult } {
  return { status: "stopped", result: { content: [{ type: "text", text }], isError: true } };
}
