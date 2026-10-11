# Architecture (proposal)

Status: **v0.1–v0.3 implemented** (2026-10-11). The reservation request is tested against a fake catalog only; the first real submission is still pending. This doc is based on [opac-research.md](opac-research.md) and on the three reports in
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
| Throttling | `p-queue` (concurrency 1, ≥ 500 ms spacing) | Politeness. All session traffic is serial anyway (see Session). |
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

## Client surface (v0.1, implemented)

`SpieleboxClient` (all methods async, all inputs validated with the exported zod schemas):

- `search({ term, keyword?, players?, age?, maxDuration?, availableOnly?, sort?, limit = 20, offset = 0 }) → { total, offset, games, asOf }`
  - **Without range filters:** fetches only the result pages (20 hits each) covering the window. If that would take more than two pages,
    it uses `printlist=true` (all hits in one request) instead. `total` comes from the media-type facet counts.
  - **Range filters** (`players`, `age` = "suitable for this age", `maxDuration`, `availableOnly`) run **client-side** on the full list
    (`printlist`). The site's own facets can't do this: they match exact values only ("ab 10 Jahren" ≠ suitable for a 10-year-old) and
    take one value per kind.
  - `keyword` uses the site facet (`cwid`), since keywords are truncated in lists. The id is resolved **by label** from the term's
    expanded keyword list (`morecws=true`) and cached for a day. If a cached id returns 0 hits, the cache is cleared and the
    search retried once, because the ids change on catalog imports. A keyword the term doesn't have → empty result, without
    another request.
- `getGames({ ids }) → { games, notFound }` with full details and the status of each copy. Resolution order, which handles detail
  pages being bound to the session:
  1. the id is in the session's current result set → fetch the details directly (the session holds the *full* result set, so this
     covers hits beyond the fetched page);
  2. the id is in the **locator index** (bounded LRU, 2000 entries: id → the term or the "new games" list that found it) → replay
     that search and fetch. Ids are grouped so each search runs once. This also handles server-side session expiry;
  3. otherwise → `notFound: "search for the game first"`. A bare id carries no title, so the client can't guess one.
- `getFilters(term) → { total, keywords, players, ageFrom, duration, years }`: all facet values with counts (`morecws` + `moreyears`).
- `newGames({ limit, offset })`: the catalog's "neue Medien" list.

Ids: `id` is the 32-hex media id, `md5(titleNo)`. The HTML never shows `titleNo`, so it isn't part of the model. `toMediaId(titleNo)`
converts numbers from staff e-mails.

## Session

- One OPAC session at a time. All catalog access goes through one mutex, because every search replaces the session's result set;
  requests are additionally spaced (default 500 ms).
- The session is dropped after 20 minutes idle (the site expires it after 24). The transport counts session changes (`generation`), so
  the client knows when its view of the result set is stale. A detail request that hits the error box is retried once after
  replaying the search.

## Caching

In memory only, bounded, no persistent cache. HTTP caching is useless here because every response is `no-cache`.

| Data | TTL | Notes |
|---|---|---|
| Details incl. availability | 2 min, LRU 500 | Always returned with `asOf`. A reservation request will re-fetch regardless. |
| Search results | 1 min, LRU 100 | Keyed by the full parameter set. |
| Keyword label → id | 1 day, LRU 5000 | Cleared on mismatch (see search). |
| Locator index | LRU 2000, no TTL | Just a term per id, so it's tiny. |

## MCP tools

| Tool | Phase | Annotations |
|---|---|---|
| `search_games` | 1 | readOnly, openWorld |
| `get_games` (≤ 10 ids) | 1 | readOnly, openWorld |
| `list_filters` | 1 | readOnly, openWorld |
| `list_new_games` | 1 | readOnly, openWorld |
| `reservation_list_add` / `_remove` / `_show` / `_clear` | 2 | not readOnly, not destructive, idempotent |
| `submit_reservation_request` | 3 | destructive, not idempotent, `_meta["anthropic/requiresUserInteraction"]: true`; output `{ sent, reason?, request? }` |

Each tool takes the client's schema as `inputSchema` and `outputSchema` and relays to one client method. Results come back as
`structuredContent` plus the same JSON as text. Client errors (`SpieleboxError`, e.g. `TOO_MANY_RESULTS`) become `isError` results with
the error code, so the model can react. Server instructions explain the search semantics. Tool descriptions stay under 2,048 characters,
which is where Claude Code truncates them.

## Reservation list (phase 2, implemented)

On the site, the Merkliste lives **server-side in the PHP session**. The browser only holds the session cookie, and the list is gone
after 24 minutes idle. This was verified with curl, which has no browser storage: the list survived across requests through the cookie alone.
`basket=add` also only works for ids in the session's current result set.

So our reservation list is kept **in our own process**: a list of ids plus their locators, deduplicated, because the server doesn't dedupe.
It is only sent to the site when a request is submitted. It stays **in memory**, like the site's: it is a staging area for one
reservation request, not a long-term list (see Glossary → wishlist).

Implementation: `addToReservationList`, `removeFromReservationList`, `clearReservationList`, `getReservationList` on the client.
Adding resolves each id through `getGames`, so only games the client has seen can be added, and the result shows current
availability. The locators of listed games are **pinned** outside the LRU, so a long session can't evict them before submission.
The list holds at most 30 games, only to keep memory bounded; the site's own limit is unknown.

## Reservation request (phase 3, implemented, not yet used for real)

The order is a binding request that the staff process by hand by e-mail. A successful submit means "request sent", not "reserved".
The tool says exactly that.

Steps in the client (`submitReservationRequest(items, contact)`):
1. Start a fresh session.
2. For each locator group: search, then `basket=add` each id.
3. `GET orderbasket`, then check the order-ability marker (ok/notok) for each item and abort if anything is unexpected.
4. `POST` with the freshly loaded `order` token. **Never retry automatically.**

Implementation notes:
- Availability is re-fetched without the cache, and the client refuses before touching the Merkliste if any game isn't available.
- The order form lists titles only (no ids). The client compares them with the expected titles and aborts on any difference
  (`ORDER_MISMATCH`), so a silently ignored `basket=add` can't produce a partial order. It also aborts if a game is marked
  "Kann nicht vorbestellt werden" (`NOT_ORDERABLE`). In both cases it clears the site's Merkliste.
- The POST is never retried. A network error after sending is reported as "outcome unknown".
- **The success page has never been recorded.** The client counts any response that is neither the error box nor the form again
  as accepted, and returns the page text verbatim. The test fixture for it is synthetic and marked as such.

Consent in the MCP layer (`submit_reservation_request`), in two independent layers, failing closed:
1. **Elicitation form** (MRTR `inputRequired`): the exact list of titles, the pickup note, the order form's checkbox wording
   verbatim, a required confirm box, and the contact fields, prefilled from `SPIELEBOX_FIRST_NAME`, `SPIELEBOX_LAST_NAME`,
   `SPIELEBOX_EMAIL` and `SPIELEBOX_PHONE` and editable.
   - `requestState` is signed by the SDK codec: an HMAC with a 5-minute TTL, bound to the method. It holds the ids shown in the
     form and a nonce, never personal data. The SDK rejects forged or expired state before the handler runs.
   - On the second round the server requires the nonce to be unused, `accept`, a ticked confirm box, and valid contact data. It then
     passes the confirmed ids to the client, which sends **only if they are exactly the reservation list**, checked inside the same
     lock as the submission, so a concurrent change can't slip in. Decline, cancel or an unticked box → `{ sent: false, reason }`,
     which is not an error.
   - The key and the nonce store are **process-wide**: the SDK may build a server instance per request, and the round trip spans two.
2. **Claude Code always-ask:** `_meta["anthropic/requiresUserInteraction"]: true` forces a permission prompt on every call, even in
   auto or bypass mode.

A client that doesn't declare elicitation can't use the tool: the SDK rejects the input request (`-32021`). Tests cover acceptance,
decline, cancel, an unticked box, a list changed mid-flow, invalid contact data, a client without forms, a replayed confirmation
and a forged state. A live probe ran the flow against the real catalog with a fetch guard that blocks every POST and Merkliste request:
the form showed the real titles and declining sent nothing.

Later, Claude Desktop could get an MCP Apps UI with a submit tool that only the app can call.

## Politeness

- A descriptive User-Agent with a contact URL.
- One request in flight, at least 500 ms apart (configurable).
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
