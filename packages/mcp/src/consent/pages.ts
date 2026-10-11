import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Contact } from "@janpaepke/spielebox-client";
import * as z from "zod";
import {
  closeLocalServer,
  escapeHtml,
  type LocalServer,
  page,
  readBody,
  send,
  startLocalServer,
} from "../web/local.ts";
import type { ConsentOutcome, ConsentRequest } from "./types.ts";
import { CONFIRM_LABEL, HEADING, ORDER_FORM_CONSENT, PICKUP_NOTE } from "./wording.ts";

type Ticket = {
  request: ConsentRequest;
  expires: number;
  outcome: ConsentOutcome | null;
  waiters: ((outcome: ConsentOutcome) => void)[];
};

/**
 * Local confirmation pages for consent through a browser (URL-mode elicitation).
 *
 * Listens on 127.0.0.1 only, on a random port. Each page is reachable through an unguessable one-time ticket
 * (`/c/<ticket>`, no personal data in the URL) and can be answered once. Requests must carry the server's exact
 * Host (DNS rebinding) and, for submissions, its Origin (cross-site posts).
 */
export class ConfirmationPages {
  readonly #tickets = new Map<string, Ticket>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  #server: Promise<LocalServer> | null = null;

  constructor({ ttlMs = 5 * 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** Creates a confirmation page for the request; returns its URL and ticket. */
  async open(request: ConsentRequest): Promise<{ url: string; ticket: string }> {
    const { origin } = await this.#start();
    this.#prune();
    const ticket = randomBytes(24).toString("base64url");
    this.#tickets.set(ticket, { request, expires: this.#now() + this.#ttlMs, outcome: null, waiters: [] });
    return { url: `${origin}/c/${ticket}`, ticket };
  }

  /** Resolves when the page was answered, or with "not granted" once the ticket expires or after `timeoutMs`. */
  waitFor(ticket: string, timeoutMs: number): Promise<ConsentOutcome> {
    const entry = this.#tickets.get(ticket);
    if (!entry) return Promise.resolve({ granted: false, reason: "The confirmation page expired." });
    if (entry.outcome) return Promise.resolve(entry.outcome);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.#settle(ticket, { granted: false, reason: "No confirmation on the page in time." });
        },
        Math.min(timeoutMs, entry.expires - this.#now()),
      );
      timer.unref();
      entry.waiters.push((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  /** Ends a ticket without confirmation (e.g. the user declined opening the page). */
  cancel(ticket: string, reason: string): void {
    this.#settle(ticket, { granted: false, reason });
  }

  async close(): Promise<void> {
    const started = await this.#server;
    this.#server = null;
    await closeLocalServer(started);
  }

  #settle(ticket: string, outcome: ConsentOutcome): void {
    const entry = this.#tickets.get(ticket);
    if (!entry || entry.outcome) return;
    entry.outcome = outcome;
    for (const waiter of entry.waiters.splice(0)) waiter(outcome);
  }

  #prune(): void {
    const now = this.#now();
    for (const [ticket, entry] of this.#tickets) {
      if (entry.expires < now) {
        this.#settle(ticket, { granted: false, reason: "The confirmation page expired." });
        this.#tickets.delete(ticket);
      }
    }
  }

  #start(): Promise<LocalServer> {
    this.#server ??= startLocalServer((req, res, origin) => this.#handle(req, res, origin));
    return this.#server;
  }

  async #handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    const ticket = /^\/c\/([\w-]{32})$/.exec(req.url ?? "")?.[1];
    const entry = ticket ? this.#tickets.get(ticket) : undefined;
    if (!ticket || !entry || entry.expires < this.#now()) {
      return send(
        res,
        404,
        page("Abgelaufen", "<p>Diese Bestätigung ist abgelaufen oder ungültig. Es wurde nichts gesendet.</p>"),
      );
    }
    if (entry.outcome) return send(res, 200, answered(entry.outcome));

    if (req.method === "GET") return send(res, 200, confirmationPage(entry.request, null));
    if (req.method !== "POST") return send(res, 405, page("Fehler", "<p>Nicht erlaubt.</p>"));
    if (req.headers.origin !== origin) return send(res, 403, page("Fehler", "<p>Ungültige Herkunft.</p>"));

    const form = new URLSearchParams(await readBody(req));
    if (form.get("action") === "decline") {
      this.#settle(ticket, { granted: false, reason: "The user declined on the confirmation page." });
      return send(res, 200, answered({ granted: false, reason: "" }));
    }
    const input = {
      firstName: form.get("firstName") ?? "",
      lastName: form.get("lastName") ?? "",
      email: form.get("email") ?? "",
      phone: form.get("phone") || undefined,
    };
    const contact = Contact.safeParse(input);
    if (form.get("confirm") !== "yes" || !contact.success) {
      const error = !contact.success ? z.prettifyError(contact.error) : `Bitte „${CONFIRM_LABEL}“ ankreuzen.`;
      return send(res, 422, confirmationPage({ ...entry.request, contact: input }, error));
    }
    this.#settle(ticket, { granted: true, contact: contact.data });
    return send(res, 200, answered({ granted: true, contact: contact.data }));
  }
}

function confirmationPage(request: ConsentRequest, error: string | null): string {
  const field = (name: keyof Contact, label: string, type = "text") =>
    `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" maxlength="40" value="${escapeHtml(request.contact[name] ?? "")}">`;
  return page(
    HEADING,
    `<h1>${escapeHtml(HEADING)}</h1>
<ul>${request.titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
<p class="note">${escapeHtml(PICKUP_NOTE)}</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post">
${field("firstName", "Vorname")}${field("lastName", "Nachname")}${field("email", "E-Mail", "email")}${field("phone", "Telefon (optional)")}
<p class="note">Mit dem Absenden wird im Formular der Spielebox bestätigt: „${escapeHtml(ORDER_FORM_CONSENT)}“</p>
<label class="consent"><input type="checkbox" name="confirm" value="yes"> <span>${escapeHtml(CONFIRM_LABEL)}</span></label>
<button class="primary" type="submit" name="action" value="confirm">Vorbestellung senden</button>
<button type="submit" name="action" value="decline" formnovalidate>Abbrechen</button>
</form>`,
  );
}

function answered(outcome: ConsentOutcome): string {
  return outcome.granted
    ? page(
        "Bestätigt",
        "<h1>Bestätigt</h1><p>Claude sendet die Vorbestellung jetzt. Das Ergebnis siehst du im Chat. Du kannst diesen Tab schließen.</p>",
      )
    : page("Abgebrochen", "<h1>Nicht gesendet</h1><p>Es wurde nichts vorbestellt. Du kannst diesen Tab schließen.</p>");
}
