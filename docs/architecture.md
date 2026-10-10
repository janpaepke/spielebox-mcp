# Architecture (proposal)

Status: **proposal; workspace scaffolded** (2026-10-11). This doc is based on [opac-research.md](opac-research.md) and on the three reports in
[research/](research/): a [survey of existing library MCP servers](research/mcp-server-survey.md),
[best practices](research/best-practices.md) and the [client stack](research/client-stack.md).
Open decisions are marked **[decide]** (none at the moment).

## Goals

- A reusable, typed **client** for the WIENXTRA OPAC. It doesn't depend on MCP and can be used from a CLI, scripts or other apps.
- A **thin MCP server** on top. Each tool is the client's zod schemas plus a one-line call to the client.
- The **binding reservation request** must never be sent without a human confirming it in the client UI.
- Build in iterations: read-only first, then the reservation list, then the reservation request.

## Glossary

The site's own terms are ambiguous, so this project uses these terms consistently in code, tools and docs:

| Term (ours) | Site term | Meaning |
|---|---|---|
| **reservation list** | Merkliste | The games staged for the *next* reservation request. Short-lived: on the site it lives in the PHP session and expires after 24 min idle. |
| **reservation request** | Vorbestellung, Onlinereservierung, Reservierungsanfrage | Submitting the reservation list with contact data. Binding for the user, but only a *request*: staff confirm it by e-mail. |
| **wishlist** | – | A long-term personal list of games someone wants to play some day. **Not in scope**, and never called that in this project to avoid confusion. If ever added, it would be persistent and separate from the reservation list. |
| **game** | Medium, Titel | One catalog title (`id` / `titleNo`). |
| **copy** | Mediennummer | One physical copy of a game, with its own availability status. |

## Stack

TypeScript, ESM-only, Node ≥ 22. A pnpm workspace with two packages: `@janpaepke/spielebox-client` and `spielebox-mcp`.
Both are `private` for now, and publishing to npm is undecided.

| Concern | Choice | Why |
|---|---|---|
| HTTP | native `fetch`, injectable | 14 of 17 TS servers in the survey use it. Injecting it gives free test seams. |
| Cookies | small cookie handling for `wienXtraopac` | One cookie, always set on a `200` (verified), so `fetch-cookie` + `tough-cookie` would be overkill. It sits in the transport layer and can be swapped out. |
| Throttling | `p-queue` (concurrency 1, ≥ 1 s spacing) | Politeness. All session traffic is serial anyway (see Session). |
| Parsing | `cheerio` (parse5 mode) | The de-facto TS choice and tolerant of sloppy markup. `node-html-parser` failed on broken tables in testing. |
| Schemas | `zod` v4, exported by the client | The single source of truth. The MCP SDK v2 takes them directly as input/output schemas. |
| MCP | `@modelcontextprotocol/server` 2.x (spec 2026-07-28), pinned to the major | Stable v2. Supports `inputRequired` elicitation and signed `requestState`. |
| Tests | `vitest` | See Testing. |
| Build | `tsdown` | `tsup` is no longer maintained. |
| TS / lint | TS 7 + Biome | typescript-eslint doesn't support TS ≥ 6.1 yet. tsdown's declaration build works on TS 7 but warns that its compiler API is still experimental. |

Python alternative: httpx + selectolax + pydantic + `mcp>=2,<3`. It works equally well but fits the existing zod/npx setup less well.

## Layers

```
packages/client
  transport/   fetch + cookie + queue + UA + GET retry (never POST)
  session/     one OPAC session behind a mutex, idle renewal, error-box → renew + replay once
  parse/       pure functions html → raw records (tested against saved HTML fixtures)
  schema/      zod domain model: Game, Copy, SearchParams, SearchResult, Facet…
  client.ts    facade: SpieleboxClient
  cli.ts       (later) a CLI on top of the facade
packages/mcp
  index.ts     registerTool(name, { inputSchema, outputSchema, annotations }, args => client.x(args))
```

Parsers never fetch, and the transport never parses. When a schema check fails, the client throws `MarkupChangedError`. That error is the alarm for when the site's markup changes.

## Client surface (v1: read-only)

- `search({ term, filters?, sort?, location? }) → { games[], total, facets }`
  - Uses `printlist=true`, so a single request returns all hits. This works as long as the site's limit of 1400 hits isn't hit.
  - Filters are given **by label** (`players: 4`, `maxDuration: 90`, `keywords: ["Kooperationsspiele"]`). Age, duration and year
    ids are computed (`md5(value)`). Player, keyword and media-type ids are looked up from the facet links of a search response,
    because they change on every catalog import.
- `getGames(ids) → Game[]` with full details and the status of each copy. Resolution order, which handles detail pages being
  bound to a session:
  1. the id is in the session's current result set → fetch the details directly;
  2. the id is in the **locator index** (a bounded LRU: id → the search term and title that found it) → re-run the search and fetch;
     ids are grouped so each search runs only once;
  3. otherwise → `UnknownGameError("search first")`. A bare id carries no title, so the client can't guess one.
- `listFacets(term)` → the values and counts available for a term.
- `newAcquisitions({ filters? })`.

Ids: `id` is the 32-hex media id. `titleNo` (an integer, with `md5(titleNo) == id`) is kept as the readable, stable id.

## Session

- One OPAC session at a time, behind a mutex. "Last result set" is state for the whole session, so concurrent searches would
  break each other's detail calls.
- A new session is started after about 20 minutes idle (the site expires sessions after 24). If the error box appears, the client starts a
  new session, replays the search and retries once.

## Caching

In memory only, bounded, no persistent cache. HTTP caching is useless here because every response is `no-cache`.

| Data | TTL | Notes |
|---|---|---|
| Game metadata (title, description, players, …) | until the next nightly import (≈ 03:00 Europe/Vienna), LRU ≈ 2k | Rarely changes. |
| Availability (status of each copy) | ≤ 120 s, never served stale | Always returned with `asOf`. Re-fetched before any reservation request. |
| Search results | 60–120 s | |
| Facet label → id maps | until the next nightly import | Throw away the whole map on any mismatch. |
| Locator index | LRU ≈ 2k, no TTL | Just term + title, so it's tiny. |

## MCP tools

| Tool | Phase | Annotations |
|---|---|---|
| `search_games` | 1 | readOnly, openWorld |
| `get_games` (≤ 10 ids) | 1 | readOnly, openWorld |
| `list_filters` | 1 | readOnly, openWorld |
| `list_new_games` | 1 | readOnly, openWorld |
| `reservation_list_add` / `_remove` / `_show` / `_clear` | 2 | not readOnly, not destructive, idempotent |
| `submit_reservation_request` | 3 | destructive, not idempotent, `_meta["anthropic/requiresUserInteraction"]: true` |

Tools return structured content plus a short text summary. They have a concise/detailed option and errors that tell the model what to do next.
Tool descriptions stay under 2,048 characters, which is where Claude Code truncates them.

## Reservation list (phase 2)

On the site, the Merkliste lives **server-side in the PHP session**. The browser only holds the session cookie, and the list is gone
after 24 minutes idle. This was verified with curl, which has no browser storage: the list survived across requests through the cookie alone.
`basket=add` also only works for ids in the session's current result set.

So our reservation list is kept **in our own process**: a list of ids plus their locators, deduplicated, because the server doesn't dedupe.
It is only sent to the site when a request is submitted. It stays **in memory**, like the site's: it is a staging area for one
reservation request, not a long-term list (see Glossary → wishlist).

## Reservation request (phase 3)

The order is a binding request that the staff process by hand by e-mail. A successful submit means "request sent", not "reserved".
The tool says exactly that.

Steps in the client (`submitReservationRequest(items, contact)`):
1. Start a fresh session.
2. For each locator group: search, then `basket=add` each id.
3. `GET orderbasket`, then check the order-ability marker (ok/notok) for each item and abort if anything is unexpected.
4. `POST` with the freshly loaded `order` token. **Never retry automatically.**

Consent in the MCP layer, in two independent layers, failing closed:
1. **Elicitation form** (`inputRequired`): shows the exact list of titles, the pickup rules and the contact details (prefilled from env,
   editable), plus the verbatim wording of the site's checkbox. The confirm box is required.
   `requestState` is HMAC-signed `{ digest(items+contact), nonce, exp: 5 min }` and contains no personal data. On retry the
   client re-derives the digest and requires it to match, and each nonce can be used only once.
2. **Claude Code always-ask:** `anthropic/requiresUserInteraction` forces a permission prompt on every call, even in auto or bypass mode.

If the client doesn't support elicitation, the tool refuses. Later, Claude Desktop could get an MCP Apps UI with a submit tool
that only the app can call.

Contact data (`SPIELEBOX_FIRSTNAME`, `…_LASTNAME`, `…_EMAIL`, `…_PHONE`) lives in the MCP server's env config. It never goes into
`requestState`, logs, URLs or tool results.

## Politeness

- A descriptive User-Agent with a contact URL.
- One request in flight, at least 1 s apart.
- GET retries at most twice with jittered backoff, respecting `Retry-After`. POST is never retried.
- A circuit breaker after repeated failures.
- No crawling features: nothing that walks the whole catalog.

## Testing

1. **Parser tests** against saved HTML fixtures: golden snapshots plus checks that survive a fixture refresh.
2. **Client tests** with an injected `fetch`: sessions, error-box recovery, locator resolution.
3. **MCP tests** over the in-memory transport, including the consent flow (decline, tampered state, replayed nonce).
4. A **live canary** behind an env flag: runs a few real searches and saves fresh fixtures on failure.

A script refreshes the fixtures from the live site and trims them.

## Iterations

1. **v0.1:** client read-only + MCP read tools + tests.
2. **v0.2:** reservation list.
3. **v0.3:** reservation request with consent. The first real order is a deliberate, user-approved test that records the success page.
