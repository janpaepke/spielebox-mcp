import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Contact, HandoffStep } from "@janpaepke/spielebox-client";
import { closeLocalServer, escapeHtml, type LocalServer, page, send, startLocalServer } from "../web/local.ts";

export type Handoff = {
  titles: string[];
  steps: HandoffStep[];
  /** Shown with copy buttons, since the catalog's own form can't be prefilled. */
  contact: Partial<Contact>;
};

/**
 * Local pages that hand the reservation list over to the user's browser: one click walks a second tab through the
 * catalog pages of the plan (clear Merkliste → searches → adds), ending on the catalog's official order form with the
 * games listed. The user submits there; nothing is sent on their behalf.
 *
 * Served on 127.0.0.1 via an unguessable ticket (`/h/<ticket>`), no personal data in the URL. The step URLs only point
 * to the catalog, and the page's script only runs with the per-response nonce.
 */
export class HandoffPages {
  readonly #handoffs = new Map<string, Handoff & { expires: number }>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  #server: Promise<LocalServer> | null = null;

  constructor({ ttlMs = 30 * 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** Creates a handoff page; returns its URL. */
  async create(handoff: Handoff): Promise<string> {
    this.#server ??= startLocalServer((req, res) => this.#handle(req, res));
    const { origin } = await this.#server;
    const now = this.#now();
    for (const [ticket, entry] of this.#handoffs) if (entry.expires < now) this.#handoffs.delete(ticket);
    const ticket = randomBytes(24).toString("base64url");
    this.#handoffs.set(ticket, { ...handoff, expires: now + this.#ttlMs });
    return `${origin}/h/${ticket}`;
  }

  async close(): Promise<void> {
    const started = await this.#server;
    this.#server = null;
    await closeLocalServer(started);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Neutral page of our own origin that the catalog tab returns to between steps (see the page script).
    if (req.url === "/blank") return send(res, 200, page("Einen Moment", '<p class="note">Einen Moment …</p>'));
    const ticket = /^\/h\/([\w-]{32})$/.exec(req.url ?? "")?.[1];
    const entry = ticket ? this.#handoffs.get(ticket) : undefined;
    if (!entry || entry.expires < this.#now()) {
      return send(
        res,
        404,
        page("Abgelaufen", "<p>Dieser Link ist abgelaufen. Bitte Claude, das Bestellformular erneut zu öffnen.</p>"),
      );
    }
    if (req.method !== "GET") return send(res, 405, page("Fehler", "<p>Nicht erlaubt.</p>"));
    const nonce = randomBytes(16).toString("base64");
    return send(res, 200, handoffPage(entry, nonce), { scriptNonce: nonce });
  }
}

const CONTACT_LABELS: [keyof Contact, string][] = [
  ["firstName", "Vorname"],
  ["lastName", "Nachname"],
  ["email", "E-Mail"],
  ["phone", "Telefon"],
];

function handoffPage(handoff: Handoff, nonce: string): string {
  const contact = CONTACT_LABELS.filter(([key]) => handoff.contact[key]);
  const contactBlock = contact.length
    ? `<p>Deine Angaben aus den Einstellungen, zum Einfügen ins Formular:</p><div class="contact">${contact
        .map(
          ([key, label]) =>
            `<span>${label}</span><code>${escapeHtml(handoff.contact[key] ?? "")}</code><button class="small" type="button" data-copy="${escapeHtml(handoff.contact[key] ?? "")}">Kopieren</button>`,
        )
        .join("")}</div>`
    : `<p class="note">Tipp: Hinterlege Name und E-Mail in den Einstellungen der Erweiterung, dann stehen sie hier zum Kopieren bereit.</p>`;
  // Inline JSON inside <script>: escape "<" so no value can close the tag.
  const plan = JSON.stringify({ steps: handoff.steps }).replace(/</g, "\\u003c");
  return page(
    "Reservierungsanfrage",
    `<h1>Reservierungsanfrage an die Spielebox</h1>
<ul>${handoff.titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
<p>Ein Klick legt diese Spiele in einem neuen Tab auf die Merkliste der Spielebox und öffnet dort das offizielle Bestellformular.
Du füllst es aus und schickst es <strong>selbst</strong> ab – vorher wird nichts gesendet.</p>
<button class="primary" id="go" type="button">Merkliste füllen und Bestellformular öffnen</button>
<p id="status" class="note" aria-live="polite"></p>
<ol class="steps" id="steps" hidden></ol>
${contactBlock}
<p class="note">Bitte prüfe im Formular, ob alle Spiele aufgelistet sind. Fehlt eines, klicke den Knopf hier einfach noch einmal.</p>
<script nonce="${nonce}">
const { steps } = ${plan};
const labels = { clear: "Merkliste leeren", search: "Spiele suchen", add: "Spiel auf die Merkliste", form: "Bestellformular öffnen" };
const list = document.getElementById("steps"), status = document.getElementById("status"), go = document.getElementById("go");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The catalog tab can't be inspected, but it is readable while it shows a page of our own origin and unreadable once
// a catalog page has replaced it. A catalog page that is shown has been processed by the catalog, so each step waits
// for exactly that, then returns the tab to our blank page before the next one. No fixed delays, no skipped steps.
const blank = location.origin + "/blank";
const ours = (tab) => { try { return tab.location.href === blank && tab.document.readyState === "complete"; } catch { return false; } };
// The catalog lets browsers cache some responses for hours (e.g. clearing the Merkliste), so every page load gets a
// unique URL, as the catalog's own scripts do. deletebasket only accepts a number.
const fresh = (url, id) =>
  url.replace(/([?&]deletebasket=)d+/, "$1" + Math.random()) + "&_=" + id;
async function until(check, ms = 20000) {
  for (const start = Date.now(); !check(); await sleep(25)) if (Date.now() - start > ms) throw new Error("timeout");
}
go.addEventListener("click", async () => {
  const tab = window.open(blank, "spielebox-bestellung");
  if (!tab) { status.textContent = "Der Browser hat das neue Tab blockiert. Bitte Pop-ups für diese Seite erlauben und erneut klicken."; return; }
  go.disabled = true; list.hidden = false;
  list.innerHTML = steps.map((s) => "<li>" + labels[s.kind] + "</li>").join("");
  try {
    await until(() => ours(tab));
    const run = Date.now().toString(36);
    for (const [i, step] of steps.entries()) {
      status.textContent = "Schritt " + (i + 1) + " von " + steps.length + " …";
      tab.location.href = fresh(step.url, run + i);
      await until(() => !ours(tab));
      if (i < steps.length - 1) { tab.location.href = blank; await until(() => ours(tab)); }
      list.children[i].className = "done";
    }
    tab.focus();
    status.textContent = "Fertig: Das Bestellformular ist im anderen Tab offen. Dort ausfüllen und abschicken.";
  } catch {
    status.textContent = "Die Spielebox hat zu lange nicht geantwortet. Bitte noch einmal versuchen.";
  }
  go.disabled = false; go.textContent = "Noch einmal";
});
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = "Kopiert ✓";
    setTimeout(() => (button.textContent = "Kopieren"), 1500);
  });
}
</script>`,
  );
}
