import type { Contact } from "@janpaepke/spielebox-client";
import type { InputRequest, inputResponse } from "@modelcontextprotocol/server";

/** What the user is asked to confirm: the games of one reservation request, and contact defaults to prefill. */
export type ConsentRequest = {
  ids: string[];
  titles: string[];
  contact: Partial<Contact>;
};

export type ConsentOutcome = { granted: true; contact: Contact } | { granted: false; reason: string };

/** The client's answer to the input request a channel asked for. */
export type ConsentAnswer = ReturnType<typeof inputResponse>;

/**
 * A way to put a consent request in front of the user. Channels only present and collect; the gate decides which
 * channel to use, protects the round trip and enforces single use.
 */
export interface ConsentChannel {
  /** Stable name, carried in the signed state to route the second round back to this channel. */
  readonly name: string;
  /** Whether the connected client can show this channel's input request. */
  supports(elicitation: { form: boolean; url: boolean }): boolean;
  /** Round 1: the input request for the client, and an optional channel ticket carried in the signed state. */
  ask(request: ConsentRequest): Promise<{ input: InputRequest; ticket?: string }>;
  /** Round 2: turns the client's answer (and, for out-of-band channels, the ticket's outcome) into a decision. */
  collect(answer: ConsentAnswer, request: ConsentRequest, ticket: string | undefined): Promise<ConsentOutcome>;
}
