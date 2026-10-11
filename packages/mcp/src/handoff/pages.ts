import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HandoffStep } from "@janpaepke/spielebox-client";
import { closeLocalServer, escapeHtml, type LocalServer, page, send, startLocalServer } from "../web/local.ts";

/** What a handoff leads to: the order form with the reservation list, or one game's detail page. */
export type Handoff =
  | { purpose: "order"; titles: string[]; steps: HandoffStep[] }
  | { purpose: "game"; title: string; steps: HandoffStep[] };

/**
 * Local pages that hand a catalog page to the user's browser. Some catalog pages only work within a session (the order
 * form with the Merkliste, a game's detail page), so one click walks a second tab through the catalog pages of the plan
 * (e.g. clear Merkliste → searches → adds → order form, or search → detail page). The user acts on the official site;
 * nothing is sent on their behalf.
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
    if (req.url === "/blank") {
      return send(res, 200, page("Einen Moment", '<p class="note">Spielebox wird vorbereitet …</p>'));
    }
    const ticket = /^\/h\/([\w-]{32})$/.exec(req.url ?? "")?.[1];
    const entry = ticket ? this.#handoffs.get(ticket) : undefined;
    if (!entry || entry.expires < this.#now()) {
      return send(
        res,
        404,
        page("Abgelaufen", "<p>Dieser Link ist abgelaufen. Bitte Claude, ihn erneut zu öffnen.</p>"),
      );
    }
    if (req.method !== "GET") return send(res, 405, page("Fehler", "<p>Nicht erlaubt.</p>"));
    const nonce = randomBytes(16).toString("base64");
    return send(res, 200, handoffPage(entry, nonce), { scriptNonce: nonce });
  }
}

/** Texts per purpose; everything else (the step runner) is shared. */
function content(handoff: Handoff) {
  const helperNote = "Dafür öffnet sich kurz ein kleines Fenster der Spielebox, das sich von selbst wieder schließt.";
  if (handoff.purpose === "game") {
    return {
      title: handoff.title,
      body: `<h1>${escapeHtml(handoff.title)}</h1>
<p>Ein Klick öffnet hier die Detailseite dieses Spiels im Katalog der Spielebox.</p>`,
      button: "Detailseite öffnen",
      note: `<p class="note">${helperNote}</p>`,
    };
  }
  return {
    title: "Reservierungsanfrage",
    body: `<h1>Reservierungsanfrage an die Spielebox</h1>
<ul>${handoff.titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
<p>Ein Klick legt diese Spiele auf die Merkliste der Spielebox und öffnet hier ihr offizielles Bestellformular.
Du füllst es aus und schickst es <strong>selbst</strong> ab – vorher wird nichts gesendet.</p>`,
    button: "Merkliste füllen und Bestellformular öffnen",
    note: `<p class="note">${helperNote} Deine Kontaktdaten kann dein Browser im Formular meist automatisch ausfüllen.</p>`,
  };
}

function handoffPage(handoff: Handoff, nonce: string): string {
  const text = content(handoff);
  // Inline JSON inside <script>: escape "<" so no value can close the tag.
  const plan = JSON.stringify({ steps: handoff.steps }).replace(/</g, "\\u003c");
  return page(
    text.title,
    `${text.body}
<button class="primary" id="go" type="button">${text.button}</button>
<p id="status" class="note" aria-live="polite"></p>
<ol class="steps" id="steps" hidden></ol>
${text.note}
<script nonce="${nonce}">
const { steps } = ${plan};
const labels = { clear: "Merkliste leeren", search: "Im Katalog suchen", add: "Spiel auf die Merkliste", form: "Bestellformular öffnen", detail: "Detailseite öffnen" };
const list = document.getElementById("steps"), status = document.getElementById("status"), go = document.getElementById("go");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The browser's cookies are shared by all its windows: a small helper window runs the preparing steps (searches, Merkliste)
// and closes, then this tab opens the final catalog page in the same catalog session. The helper can't be inspected,
// but it is readable while it shows a page of our own origin and unreadable once a catalog page has replaced it. A
// catalog page that is shown has been processed by the catalog, so each step waits for exactly that and returns the
// helper to our blank page before the next one. No fixed delays, no skipped steps.
const blank = location.origin + "/blank";
const ours = (w) => { try { return w.location.href === blank && w.document.readyState === "complete"; } catch { return false; } };
// The catalog lets browsers cache some responses for hours (e.g. clearing the Merkliste), so every page load gets a
// unique URL, as the catalog's own scripts do. deletebasket only accepts a number.
const fresh = (url, id) =>
  url.replace(/([?&]deletebasket=)\\d+/, "$1" + Math.random()) + "&_=" + id;
async function until(check, ms = 20000) {
  for (const start = Date.now(); !check(); await sleep(25)) if (Date.now() - start > ms) throw new Error("timeout");
}
go.addEventListener("click", async () => {
  const helper = window.open(blank, "spielebox-helfer", "popup,width=420,height=240");
  if (!helper) { status.textContent = "Der Browser hat das Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut klicken."; return; }
  go.disabled = true; list.hidden = false;
  list.innerHTML = steps.map((s) => "<li>" + labels[s.kind] + "</li>").join("");
  const run = Date.now().toString(36);
  const prepare = steps.slice(0, -1), target = steps[steps.length - 1];
  try {
    await until(() => ours(helper));
    for (const [i, step] of prepare.entries()) {
      status.textContent = labels[step.kind] + " … (" + (i + 1) + " von " + steps.length + ")";
      helper.location.href = fresh(step.url, run + i);
      await until(() => !ours(helper));
      if (i < prepare.length - 1) { helper.location.href = blank; await until(() => ours(helper)); }
      list.children[i].className = "done";
    }
    helper.close();
    list.children[steps.length - 1].className = "done";
    status.textContent = labels[target.kind] + " …";
    location.href = fresh(target.url, run + "z");
  } catch {
    helper.close();
    status.textContent = "Die Spielebox hat zu lange nicht geantwortet. Bitte noch einmal versuchen.";
    go.disabled = false; go.textContent = "Noch einmal";
  }
});
</script>`,
  );
}
