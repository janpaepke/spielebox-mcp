import { readFileSync } from "node:fs";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const idsIn = (html: string) => [...html.matchAll(/id="mnr([0-9a-f]{32})"/g)].map((m) => m[1] ?? "");

/** Ids per search term, i.e. the result set a search puts into the session. */
const RESULT_SETS: Record<string, string[]> = {
  catan: idsIn(fixture("search-catan-printlist.html")),
  "catan connect": idsIn(fixture("search-single-hit.html")),
  new: idsIn(fixture("new-games.html")),
};

const DETAILS: Record<string, string> = {
  "3375ddafbc45fed35c0da0b4cc481084": "detail-catan-connect.html",
  c1d18eefb1bd1698c74653c0980f950d: "detail-abenteuer-menschheit.html",
};
/** Ids without their own fixture get this stand-in; the parser takes the id from the request anyway. */
const STAND_IN_DETAIL = "detail-galaxy-trucker.html";

const detailFor = (id: string, standIn = STAND_IN_DETAIL) => fixture(DETAILS[id] ?? standIn);
const titleOf = (id: string) => /<h1>([^<]+)<\/h1>/.exec(detailFor(id).split('id="details_sb"')[1] ?? "")?.[1] ?? "";

/**
 * NOT recorded from the site: the real page after submitting an order has never been captured (see
 * docs/opac-research.md). Stand-in so the client's success path can be exercised.
 */
const SYNTHETIC_ORDER_SUCCESS = fixture("order-form-empty.html").replace(
  /<div id="errorbox">.*?<\/div>/s,
  '<div id="details_sb"><h1>Onlinereservierung</h1><p>Vielen Dank! Ihre Reservierung wurde übermittelt.</p></div>',
);

type Session = { term: string; basket: string[]; token: string | null };

/**
 * In-memory stand-in for the OPAC, serving the recorded fixtures. Models what matters for the client:
 * session cookies, detail pages and Merkliste adds that only work for ids in the session's last result set,
 * and the order form with its per-render token.
 */
export class FakeOpac {
  readonly requests: URLSearchParams[] = [];
  readonly orders: URLSearchParams[] = [];
  /** Ids the order form marks as "Kann nicht vorbestellt werden". */
  readonly notOrderable = new Set<string>();
  /** Ids whose `basket=add` is silently ignored. */
  readonly ignoreAdds = new Set<string>();
  /** Detail page for ids without their own fixture (default: a game whose copies are all borrowed). */
  standInDetail = STAND_IN_DETAIL;
  /** Response to an order POST: "accept", "error" (error box) or "network" (fetch throws). */
  orderOutcome: "accept" | "error" | "network" = "accept";

  readonly #sessions = new Map<string, Session>();
  #nextSession = 1;
  #nextToken = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const params = new URL(String(input)).searchParams;
    this.requests.push(params);
    const cookie = /wienXtraopac=(\w+)/.exec(new Headers(init?.headers).get("cookie") ?? "")?.[1];
    const id = cookie && this.#sessions.has(cookie) ? cookie : `s${this.#nextSession++}`;
    const session = this.#sessions.get(id) ?? { term: "", basket: [], token: null };
    this.#sessions.set(id, session);
    const headers = { "content-type": "text/html; charset=utf-8", "set-cookie": `wienXtraopac=${id}; path=/` };
    if (init?.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      this.orders.push(form);
      if (this.orderOutcome === "network") throw new TypeError("socket hang up");
      const valid = this.orderOutcome === "accept" && form.get("order") === session.token && session.basket.length > 0;
      if (valid) session.basket = [];
      return new Response(valid ? SYNTHETIC_ORDER_SUCCESS : fixture("detail-not-in-session.html"), { headers });
    }
    return new Response(this.#respond(params, session), { headers });
  };

  /** Simulates the server forgetting all sessions (PHP session expiry). */
  expireSessions(): void {
    this.#sessions.clear();
  }

  /** Requests in a compact form for assertions (without `location`). */
  get log(): string[] {
    return this.requests.map((p) => {
      const { location, ...rest } = Object.fromEntries(p);
      return new URLSearchParams(rest).toString();
    });
  }

  #respond(p: URLSearchParams, session: Session): string {
    const inSet = (id: string) => RESULT_SETS[session.term]?.includes(id) ?? false;
    const media = p.get("media");
    if (p.get("basket") === "add" && media) {
      if (inSet(media) && !this.ignoreAdds.has(media)) session.basket.push(media);
      return "";
    }
    if (p.has("deletebasket")) {
      session.basket = [];
      return "";
    }
    if (p.get("orderbasket")) return this.#orderForm(session);
    if (media) return inSet(media) ? detailFor(media, this.standInDetail) : fixture("detail-not-in-session.html");
    if (p.get("newmedia")) {
      session.term = "new";
      return fixture("new-games.html");
    }
    const term = p.get("sword") ?? "";
    session.term = term;
    if (term.length < 3) return fixture("search-too-short.html");
    if (term === "spiel") return fixture("search-too-many.html");
    if (term === "catan connect") return fixture("search-single-hit.html");
    if (term !== "catan") return fixture("search-no-results.html");
    if (p.get("printlist")) return fixture("search-catan-printlist.html");
    if (p.get("morecws")) return fixture("search-catan-morecws.html");
    if (p.get("offset") === "20") return fixture("search-catan-page2.html");
    return fixture("search-catan.html");
  }

  /** The recorded order form, re-rendered with this session's Merkliste and a fresh token. */
  #orderForm(session: Session): string {
    if (!session.basket.length) return fixture("order-form-empty.html");
    session.token = `token${this.#nextToken++}`;
    const template = fixture("order-form.html");
    const item = /<div class="lbasket">.*?<div class="bspacer"><\/div>/s.exec(template)?.[0] ?? "";
    const items = session.basket
      .map((id) =>
        item
          .replace(/(<div class="mbasket">)[^<]*/, `$1${titleOf(id)}`)
          .replace(/(<div class="obasket"><img src="img\/)ok/, `$1${this.notOrderable.has(id) ? "notok" : "ok"}`),
      )
      .join("");
    return template.replace(item, items).replace(/(name="order" value=")[0-9a-f]+/, `$1${session.token}`);
  }
}
