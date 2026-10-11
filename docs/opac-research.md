# WIENXTRA OPAC — research notes

Findings from probing `https://opac.wienxtra.at` (2026-10-10). Everything below was verified
against the live site unless marked otherwise.

## What kind of server is it?

- Custom in-house PHP app: footer and source comment say **"wienXtra PHP Factory", © Andreas Fragner, 2013**,
  UI version `v2.2.2d`. Apache 2.4, jQuery 2.1.1, XHTML 1.0 Strict markup.
- **No standard library interface**: no SRU/Z39.50, OAI-PMH, unAPI, OpenSearch, RSS, sitemap, JSON API.
  (Probed `api/`, `api.php`, `sru`, `oai`, `unapi`, `opensearch.xml`, `rss.php`, `.well-known/`, `format=json`, … → 404 or HTML.)
- No machine-readable description of resources (nothing OpenAPI-like). The HTML *is* the API.
- Not a known ILS frontend (Koha, Primo, aDISWeb, …) — so no existing client or MCP for "this kind of system" exists.
  The data likely comes from a back-office system via a nightly import (see facet ids below) — unconfirmed.

## Endpoints (all `GET /index.php`)

| Purpose | Params | Notes |
|---|---|---|
| Search | `newsearch=true&location=sb&sword=<term>[&offset=n][&sortorder=<id>][&<facet>=<id>…]` | 20 hits/page. Stateless — facets work without a session. |
| Full result list | same + `printlist=true` | **All hits in one response**, same markup as list. Also seeds the session for details. |
| Facet drill-down (UI) | `newsearch=false&…&<facet>=<id>` | Works statelessly too when `sword` is repeated. |
| New acquisitions | `newmedia=true&newsearch=true&location=sb` | Paged list (~11 pages today). Facets apply (seen in archived URLs). |
| Detail | `media=<md5>&location=sb` | **Session-bound**: only resolves if the id is in the session's last search result set, else `id="errorbox"`. The session keeps the **full** result set: after a page-1 search, details of hits on later pages resolve too. |
| Expand facet lists | `moreyears=true`, `morecws=true`, `moreauthors=true`, `moreagefrom=true` | Shows all values of a facet. |
| Imprint | `imprint=true` | |
| Merkliste / pre-order | `basket=add\|remove&media=<md5>`, `basketinfo`, `showbasket`, `orderbasket`, `deletebasket` | Session-based basket → online pre-order form. See [Merkliste & pre-order](#merkliste--pre-order). |

Session cookie: `wienXtraopac` (PHP session, `Max-Age=1440` = 24 min idle). It is set on the first `200` response (no redirect), and the
session id never appears in URLs. Language cookie `lang=de`.

Responses are `text/html; charset=utf-8` and `Cache-Control: no-cache, must-revalidate` (HTTP caching is useless). Query parameters must be
**UTF-8** percent-encoded: `Fl%C3%BCgelschlag` finds FLÜGELSCHLAG, while Latin-1 `Fl%FCgelschlag` returns an empty page. A search with a single
hit renders the normal list (no redirect to the detail page).

### Locations

`location=sb` (Spielebox). `default`/omitted = all facilities (the WIENXTRA library), `ifp` exists in archived URLs but returns nothing today.

## Search semantics

- `sword` must be **≥ 3 characters**, else "Bitte wählen Sie einen Suchbegriff der mindestens 3 Zeichen lang ist."
- **> 1400 hits → refused** ("…mehr als 1400 Ergebnisse – bitte verfeinern Sie den Suchbegriff"), even with facets set.
  ⇒ Facets only *narrow* a term search; you cannot browse the catalog by facet alone.
- Matching is **substring, contiguous phrase**: `cata` matches, `die siedler` matches, `catan kosmos` does not. No AND/OR, no quotes, no wildcards (`catan*` → 0).
- Searched fields include title, author, description (e.g. a term from a blurb returns unrelated titles) ⇒ clients should offer title filtering.
- No hits → `<div id="messagebox">` with an "Infomeldung".
- `offset`, `sortorder`, `morecws=true` and `printlist=true` all work statelessly with `newsearch=true`. `printlist` honors facets but renders no facet box.
- Each facet kind takes **one value**: repeating a param (`cwid=a&cwid=b`) applies only the last one.
- Sorting is ascending only (`sortorder=md5("erscheinungsjahr")` → 1995, 1995, 1997 …).

## Identifiers

| Id | Form | Stable? |
|---|---|---|
| Media (title) | `md5(titelid)` where `titelid` is an integer (e.g. `md5("60081")` = CATAN Connect) | **Yes** (DB key) |
| Copy | `Mediennummer` integer (e.g. `54559`) on the detail page | Yes |
| `agefromid`, `maxdurationid`, `yearid` | `md5(value)`: `md5("10")` = "ab 10 Jahren", `md5("90")` = "bis zu 90 Minuten", `md5("2025")` | **Yes — computable** |
| `sortorder` | `md5(column)`: `md5("erscheinungsjahr")`, `md5("alter_von")`, `md5("systematik")`; title/author ids not reversed but constant | Yes |
| `gamerid`, `cwid` (Schlagworte), `medid`, `standid` | PHP `uniqid()` (hex timestamp prefix) | **No.** The prefix decodes to 2026-10-10 03:00. Wayback shows `56f5ed3a…` (2016) and `5947221a…` (2017). On 2026-10-11 they were *unchanged*, so they are regenerated on (irregular) catalog imports, not nightly ⇒ resolve **by label**, cache the map, refresh it on mismatch. |

## Data available

**List (per hit):** title, availability (aggregated: any copy available), media type, location, authors, publisher,
year, age ("ab N Jahren"), duration bucket ("bis zu N Minuten"), players ("N bis M"), description (**truncated**),
keywords (**truncated**), note "Dieser Titel muss online vorbestellt werden".

**Detail:** everything above untruncated, plus per-copy `Mediennummer` + status, exact duration range ("30 bis 45 Minuten").
No images, no EAN, no due dates.

**Facets on every result page (with counts):** Standort, Medienart, Erscheinungsjahr, Alterseignung, Spieldauer,
SpielerInnen (1, 2, 3, 4, 5, viele), Schlagworte (incl. useful ones like `ausgezeichnet`, `Deckbuildingspiele`,
`Kooperationsspiele`, `Erweiterung zum Basisspiel`).

**Status icons:** `status_green` entlehnbar, `status_blue` vor Ort nutzbar, `status_red` entliehen, `status_unknown`.

## Merkliste & pre-order

Verified via curl and a browser session with network capture (2026-10-10). **The order form was never submitted** —
submission creates a binding pre-order.

- Browser traffic: no hidden APIs. Only jQuery, `functions.js` and Google Analytics. The add/remove buttons fire
  `GET index.php?basket=add|remove&media=<md5>&location=sb`, followed by `GET index.php?basketinfo=<random>` to refresh the header
  (their JS appends `&location` outside the `.load()` URL, so it's never sent).
- The Merkliste lives in the PHP session only (no account). It **accumulates across searches**.
- `basket=add` only works if the id is in the session's **current search result set** (same binding as detail pages).
  A blind add in a fresh session is silently ignored.
- **No server-side dedupe:** adding the same id twice counts it twice ⇒ the client must dedupe.
- **At most 6 games per reservation request** (verified 2026-10-11): with more on the Merkliste, `orderbasket` shows
  "Sie haben für den Standort spielebox zu viele Medien auf der Merkliste. Maximal können 6 Medien für diesen Standort
  vorbestellt werden." instead of the form.
- `deletebasket` only clears with a **numeric** value (the site sends `Math.random()`); `deletebasket=zz71` is ignored.
  Its response is `cache-control: private, max-age=10800`, so a browser serves repeated identical URLs from cache for 3 h
  without asking the server ⇒ browsers need a unique URL per request (the site's own scripts do this). An extra `_=…`
  parameter is ignored by the catalog.
- **Requests of one session are processed strictly in order** (PHP session locking): a 60 ms request sent while a 1.3 s
  search runs finishes only after it. Requests the client cancels still take effect.
- `basketinfo` → small HTML snippet ("N Medien auf der Merkliste" + links), empty string when the basket is empty.
- `showbasket=true` → the basket rendered as a normal result list (with facets). Does **not** seed the detail result set.
- `deletebasket=<any>` clears the basket.
- `orderbasket=true` (GET) → form "Onlinereservierung":
  - `POST /index.php?orderbasket=true&location=sb`
  - fields: `location=sb`, `order=<32 hex>` (hidden token, **changes on every render** ⇒ GET the form right before POSTing),
    `firstname`*, `lastname`*, `email`*, `phone`, `agb=ja`* — all `maxlength=40`; no client-side validation.
  - The `agb` checkbox is **required to order**. It is worded as consent to data use: "Ich stimme bis auf Widerruf der Verwendung
    meiner bekannt gegebenen Daten zum Zweck der Zusendung von Informationen über Angebote des Vereins wienXtra zu."
    Its practical purpose is to allow wienXtra to send the order confirmation. The client sets it as part of an order and shows
    the verbatim text in the consent step.
  - Lists each basket item with `ok.png` "Kann vorbestellt werden" / `notok.png` "Kann nicht vorbestellt werden".
- Empty basket + `orderbasket` → "Es befinden sich keine Medien auf der Merkliste, daher kann kein Bestellvorgang eingeleitet werden!"

### What a submitted order does (from a real order, 2026-10-09)

The OPAC sends **no confirmation to the customer**. It e-mails a request to the staff, and they handle it by hand:

1. On submit, the OPAC sends a mail "Reservierungsanfrage über wienXtra webOPAC"
   **to `spielebox@wienxtra.at`, with the customer's address as `From`**. It contains:
   - timestamp
   - customer data: Vorname, Nachname, E-Mail, Telefon, "Datenschutzbestimmungen akzeptiert: ja". This is the `agb` checkbox,
     which internal systems treat as privacy-terms acceptance.
   - per title: Titel, **Signatur** (shelf mark, e.g. `SP/SCH`), **TitelNr** (e.g. `59721`, and `md5("59721")` is the media id),
     and per copy: **MedienNr**, **NSO** (e.g. `M2/6`), status (`verfügbar`, or `verf./onl.res.` for the copy the order reserved).
2. The staff reply to the customer when the games are ready ("deine Spiele sind bereit … innerhalb von zwei Werktagen abholen"),
   listing the titles. In our case the reply came the next morning, before opening.

Consequences for the client:
- An order is a **request**, not a booking. Success can only mean "the form was accepted", and the real confirmation is a human e-mail.
- Signatur, NSO and per-copy reservation status are internal data. They never appear in the public OPAC HTML.

After POST the page showed a success message saying a confirmation would follow. This is from memory; the exact
markup and wording are not recorded.

**Still unknown:** the exact success markup, validation error pages, and whether items that can't be pre-ordered block the order.

### Handing the Merkliste to the user's browser (verified 2026-10-11)

- The session id is **only accepted as a cookie** (`?wienXtraopac=`, `?PHPSESSID=`, `?sid=`, `?session=` are ignored), and
  the order form ignores `?firstname=…` etc. A prefilled order link is therefore impossible.
- A page on another origin can't set the catalog's cookie or read its pages, but it can walk a tab through plain top-level
  page loads (clear → search → add → `orderbasket`): the browser then gets its own catalog session with exactly those
  games, ending on the official order form. Tested in Chromium with fresh, existing and over-full sessions.
Capture these on the first real order made through the client.

Site rules (home page): order at least one day before pickup; pick up within 3 working days.

## Etiquette

`robots.txt` disallows crawling of facet params (`gamerid`, `cwid`, …), `/lib/`, `/config/` etc. A user-driven client
at human-ish volume is a different thing from a crawler, but the client should: send a descriptive User-Agent,
avoid fan-out (prefer `printlist` over paging; fetch details only on demand), and cache.

## What already exists (2026-10-10)

Nothing for this OPAC: no hits for "wienxtra"/"spielebox"/"opac.wienxtra.at" in the official MCP registry, npm,
GitHub repos/code, Glama, LobeHub. Related reference implementations for *other* catalogs:

- [tilllt/adisweb-client](https://github.com/tilllt/adisweb-client) — Python client + MCP server for aDISWeb OPACs (same client/MCP split).
- [jfposton/mcp-wcpl](https://glama.ai/mcp/servers/jfposton/mcp-wcpl) — TS, scrapes a library catalog with Cheerio.
