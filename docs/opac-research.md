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
| Detail | `media=<md5>&location=sb` | **Session-bound**: only resolves if the id is in the current session's last result set, else `id="errorbox"`. |
| Expand facet lists | `moreyears=true`, `morecws=true`, `moreauthors=true`, `moreagefrom=true` | Shows all values of a facet. |
| Imprint | `imprint=true` | |
| Merkliste / pre-order | `basket=add\|remove\|removeall&media=<md5>`, `basketinfo`, `showbasket`, `orderbasket`, `deletebasket` | Session-based "basket" → online pre-order form. **Not probed** (would touch the real order flow). |

Session cookie: `wienXtraopac` (PHP session, `Max-Age=1440` = 24 min idle). Language cookie `lang=de`.

### Locations

`location=sb` (Spielebox). `default`/omitted = all facilities (the WIENXTRA library), `ifp` exists in archived URLs but returns nothing today.

## Search semantics

- `sword` must be **≥ 3 characters**, else "Bitte wählen Sie einen Suchbegriff der mindestens 3 Zeichen lang ist."
- **> 1400 hits → refused** ("…mehr als 1400 Ergebnisse – bitte verfeinern Sie den Suchbegriff"), even with facets set.
  ⇒ Facets only *narrow* a term search; you cannot browse the catalog by facet alone.
- Matching is **substring, contiguous phrase**: `cata` matches, `die siedler` matches, `catan kosmos` does not. No AND/OR, no quotes, no wildcards (`catan*` → 0).
- Searched fields include title, author, description (e.g. a term from a blurb returns unrelated titles) ⇒ clients should offer title filtering.
- No hits → `<div id="messagebox">` with an "Infomeldung".

## Identifiers

| Id | Form | Stable? |
|---|---|---|
| Media (title) | `md5(titelid)` where `titelid` is an integer (e.g. `md5("60081")` = CATAN Connect) | **Yes** (DB key) |
| Copy | `Mediennummer` integer (e.g. `54559`) on the detail page | Yes |
| `agefromid`, `maxdurationid`, `yearid` | `md5(value)`: `md5("10")` = "ab 10 Jahren", `md5("90")` = "bis zu 90 Minuten", `md5("2025")` | **Yes — computable** |
| `sortorder` | `md5(column)`: `md5("erscheinungsjahr")`, `md5("alter_von")`, `md5("systematik")`; title/author ids not reversed but constant | Yes |
| `gamerid`, `cwid` (Schlagworte), `medid`, `standid` | PHP `uniqid()` (hex timestamp prefix) | **No.** Prefix decodes to 2026-10-10 03:00 today; Wayback shows `56f5ed3a…` (2016), `5947221a…` (2017). Regenerated on import ⇒ must be resolved **by label** from a search page each time. |

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

## Etiquette

`robots.txt` disallows crawling of facet params (`gamerid`, `cwid`, …), `/lib/`, `/config/` etc. A user-driven client
at human-ish volume is a different thing from a crawler, but the client should: send a descriptive User-Agent,
avoid fan-out (prefer `printlist` over paging; fetch details only on demand), and cache.

## What already exists (2026-10-10)

Nothing for this OPAC: no hits for "wienxtra"/"spielebox"/"opac.wienxtra.at" in the official MCP registry, npm,
GitHub repos/code, Glama, LobeHub. Related reference implementations for *other* catalogs:

- [tilllt/adisweb-client](https://github.com/tilllt/adisweb-client) — Python client + MCP server for aDISWeb OPACs (same client/MCP split).
- [jfposton/mcp-wcpl](https://glama.ai/mcp/servers/jfposton/mcp-wcpl) — TS, scrapes a library catalog with Cheerio.
