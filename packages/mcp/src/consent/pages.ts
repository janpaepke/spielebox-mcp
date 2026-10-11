import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Contact } from "@janpaepke/spielebox-client";
import * as z from "zod";
import type { ConsentOutcome, ConsentRequest } from "./types.ts";
import { CONFIRM_LABEL, HEADING, ORDER_FORM_CONSENT, PICKUP_NOTE } from "./wording.ts";

type Ticket = {
  request: ConsentRequest;
  expires: number;
  outcome: ConsentOutcome | null;
  waiters: ((outcome: ConsentOutcome) => void)[];
};

const MAX_BODY = 16 * 1024;

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
  #server: Promise<{ server: Server; origin: string }> | null = null;

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
    await new Promise((resolve) => started?.server.close(resolve) ?? resolve(undefined));
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

  #start(): Promise<{ server: Server; origin: string }> {
    this.#server ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.#handle(req, res, origin).catch(() => send(res, 500, page("Fehler", "<p>Etwas ist schiefgelaufen.</p>")));
      });
      let origin = "";
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        server.unref();
        resolve({ server, origin });
      });
    });
    return this.#server;
  }

  async #handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    if (req.headers.host !== new URL(origin).host) return send(res, 421, page("Fehler", "<p>Unerwarteter Host.</p>"));
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} – Spielebox</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.4rem}ul{padding-left:1.2rem}label{display:block;margin:.6rem 0 .2rem}input[type=text],input[type=email]{width:100%;padding:.4rem;box-sizing:border-box}
.consent{display:flex;gap:.5rem;align-items:flex-start;margin:1rem 0;padding:.8rem;background:#fff;border:1px solid #ccc;border-radius:6px}
.consent input{margin-top:.3rem}.note{color:#555;font-size:.9rem}.error{color:#a00;white-space:pre-wrap}
button{font:inherit;padding:.5rem 1rem;margin:.5rem .5rem 0 0;cursor:pointer}button.primary{background:#1a5;color:#fff;border:0;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#eee}.consent{background:#262626;border-color:#444}.note{color:#aaa}}
</style></head><body>${body}</body></html>`;
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
