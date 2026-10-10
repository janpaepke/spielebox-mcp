# Architecture (proposal)

Status: **proposal, not built yet** (2026-10-10). This doc is based on [opac-research.md](opac-research.md) and on the three reports in
[research/](research/): a [survey of existing library MCP servers](research/mcp-server-survey.md),
[best practices](research/best-practices.md) and the [client stack](research/client-stack.md).
Open decisions are marked **[decide]**.

## Goals

- A reusable, typed **client** for the WIENXTRA OPAC. It doesn't depend on MCP and can be used from a CLI, scripts or other apps.
- A **thin MCP server** on top. Each tool is the client's zod schemas plus a one-line call to the client.
- The **binding pre-order** must never happen without a human confirming it in the client UI.
- Build in iterations: read-only first, then the wishlist (Merkliste), then the pre-order.

## Stack

TypeScript, ESM-only, Node ≥ 22. A pnpm workspace with two packages.

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
| TS / lint | **[decide]** TS 7 + Biome, *or* TS ~6.0 + typescript-eslint | typescript-eslint doesn't support TS ≥ 6.1 yet. |

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
| Availability (status of each copy) | ≤ 120 s, never served stale | Always returned with `asOf`. Re-fetched before any pre-order. |
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
| `wishlist_add` / `wishlist_remove` / `wishlist_show` | 2 | not readOnly, not destructive, idempotent (add/remove) |
| `request_preorder` | 3 | destructive, not idempotent, `_meta["anthropic/requiresUserInteraction"]: true` |

Tools return structured content plus a short text summary. They have a concise/detailed option and errors that tell the model what to do next.
Tool descriptions stay under 2,048 characters, which is where Claude Code truncates them.

## Wishlist (phase 2)

The Merkliste lives in the PHP session, and `basket=add` only works for ids in the session's current result set. So the wishlist
is kept **in our own process**: a list of ids plus their locators, deduplicated, because the server doesn't dedupe.
**[decide]** in memory only, or persisted to a small JSON file so it survives restarts.

## Pre-order (phase 3)

The order is a binding request that the staff process by hand by e-mail. A successful submit means "request sent", not "reserved".
The tool says exactly that.

Steps in the client (`submitPreorder(items, contact)`):
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
2. **v0.2:** wishlist.
3. **v0.3:** pre-order with consent. The first real order is a deliberate, user-approved test that records the success page.
