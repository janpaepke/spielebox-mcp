import { inputRequired } from "@modelcontextprotocol/server";
import type { ConfirmationPages } from "./pages.ts";
import type { ConsentAnswer, ConsentChannel, ConsentOutcome, ConsentRequest } from "./types.ts";
import { HEADING } from "./wording.ts";

/**
 * Consent through a local confirmation page in the browser (URL-mode elicitation), for clients without forms
 * (e.g. Claude Desktop). The client asks the user to open the page; the second round then waits for the page's answer.
 */
export class UrlConsentChannel implements ConsentChannel {
  readonly name = "url";
  readonly #pages: ConfirmationPages;
  readonly #waitMs: number;

  constructor(pages: ConfirmationPages, { waitMs = 4 * 60_000 }: { waitMs?: number } = {}) {
    this.#pages = pages;
    this.#waitMs = waitMs;
  }

  supports(elicitation: { url: boolean }): boolean {
    return elicitation.url;
  }

  async ask(request: ConsentRequest) {
    const { url, ticket } = await this.#pages.open(request);
    const games = request.titles.length === 1 ? "1 Spiel" : `${request.titles.length} Spiele`;
    return {
      input: inputRequired.elicitUrl({
        url,
        message: `${HEADING} (${games}): Bitte im Browser prüfen und bestätigen. Ohne Bestätigung wird nichts gesendet.`,
      }),
      ticket,
    };
  }

  async collect(answer: ConsentAnswer, _request: ConsentRequest, ticket: string | undefined): Promise<ConsentOutcome> {
    if (!ticket) return { granted: false, reason: "Missing confirmation page." };
    if (answer.kind !== "elicit" || answer.action !== "accept") {
      const reason = answer.kind === "elicit" && answer.action === "decline" ? "declined" : "cancelled";
      this.#pages.cancel(ticket, `The user ${reason} opening the confirmation page.`);
      return { granted: false, reason: `The user ${reason} opening the confirmation page.` };
    }
    // "accept" only means the user agreed to open the page; the decision is made there.
    return this.#pages.waitFor(ticket, this.#waitMs);
  }
}
