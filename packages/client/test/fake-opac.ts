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

/**
 * In-memory stand-in for the OPAC, serving the recorded fixtures. Models what matters for the client:
 * session cookies, and detail pages that only resolve for ids in the session's last result set.
 */
export class FakeOpac {
  readonly requests: URLSearchParams[] = [];
  /** Cookie → term of the session's last search. */
  readonly #sessions = new Map<string, string>();
  #nextSession = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const params = new URL(String(input)).searchParams;
    this.requests.push(params);
    const cookie = /wienXtraopac=(\w+)/.exec(new Headers(init?.headers).get("cookie") ?? "")?.[1];
    const session = cookie && this.#sessions.has(cookie) ? cookie : `s${this.#nextSession++}`;
    if (!this.#sessions.has(session)) this.#sessions.set(session, "");
    const headers = { "content-type": "text/html; charset=utf-8", "set-cookie": `wienXtraopac=${session}; path=/` };
    return new Response(this.#respond(params, session), { headers });
  };

  /** Simulates the server forgetting all sessions (PHP session expiry). */
  expireSessions(): void {
    this.#sessions.clear();
  }

  /** Requests other than for static data, in a compact form for assertions. */
  get log(): string[] {
    return this.requests.map((p) => {
      const { location, ...rest } = Object.fromEntries(p);
      return new URLSearchParams(rest).toString();
    });
  }

  #respond(p: URLSearchParams, session: string): string {
    const media = p.get("media");
    if (media) {
      const term = this.#sessions.get(session) ?? "";
      const inSet = RESULT_SETS[term]?.includes(media);
      // Ids without their own fixture get a stand-in detail page; the parser takes the id from the request anyway.
      if (!inSet) return fixture("detail-not-in-session.html");
      return fixture(DETAILS[media] ?? "detail-galaxy-trucker.html");
    }
    if (p.get("newmedia")) {
      this.#sessions.set(session, "new");
      return fixture("new-games.html");
    }
    const term = p.get("sword") ?? "";
    this.#sessions.set(session, term);
    if (term.length < 3) return fixture("search-too-short.html");
    if (term === "spiel") return fixture("search-too-many.html");
    if (term === "catan connect") return fixture("search-single-hit.html");
    if (term !== "catan") return fixture("search-no-results.html");
    if (p.get("printlist")) return fixture("search-catan-printlist.html");
    if (p.get("morecws")) return fixture("search-catan-morecws.html");
    if (p.get("offset") === "20") return fixture("search-catan-page2.html");
    return fixture("search-catan.html");
  }
}
