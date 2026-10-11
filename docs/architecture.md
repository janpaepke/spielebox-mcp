# Architecture

Status: **v0.1–v0.3 implemented, plus consent channels and the Claude Desktop extension** (2026-10-11). The reservation request is
tested against a fake catalog only; the first real submission is still pending. This doc builds on
[opac-research.md](opac-research.md), research into existing library/catalog MCP servers, MCP best practices and client stacks.
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
  server.ts    registerTool(name, { inputSchema, outputSchema, annotations }, args => client.x(args))
  consent/     gate (signed round trip, single use, channel choice) + channels: form, url (local page) …
  index.ts     wires one client and one consent gate for the process, serves stdio
  mcpb/        Claude Desktop extension manifest (packaging only, no code)
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
The list holds at most 6 games, the catalog's limit per reservation request.

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

### Consent layer

Consent is a separate layer between the tool and the client UI:

- **Gate** (`consent/gate.ts`): one per process, shared by all server instances (the SDK may build one per request, while the
  round trip spans two). It chooses the first channel the client supports, puts the shown ids, the channel and a single-use nonce
  into SDK-signed `requestState` (HMAC, 5 min, bound to the method; no personal data), enforces single use, and routes round 2 back
  to the channel. The SDK rejects forged or expired state before the handler runs.
- **Channels** (`consent/*.ts`) only present and collect:
  - **form**: an elicitation form in the client (Claude Code): exact titles, pickup note, the order form's checkbox wording
    verbatim, a required confirm box, contact fields prefilled from config and editable.
  - **url**: for clients with URL-mode elicitation only (**Claude Desktop**, see below). A local confirmation page with the same
    content on `127.0.0.1` (random port, one-time ticket in the path, no personal data in the URL, Host and Origin checks, escaped
    content, strict CSP). The client asks the user to open it; round 2 then waits (up to 4 min) for the page's answer, which is the
    flow the spec describes for URL mode.
  - Future channels (e.g. MCP Apps) plug in without touching the tools.
- **Tool**: once a channel grants consent, the tool passes the confirmed contact and ids to the client, which sends **only if the
  ids are exactly the reservation list**, checked inside the same lock as the submission. Decline, cancel, an unticked box or a
  timeout → `{ sent: false, reason }`, which is not an error.
- **Claude Code always-ask:** `_meta["anthropic/requiresUserInteraction"]: true` forces a permission prompt on every call, even in
  auto or bypass mode. A second, independent layer.

A client with neither form nor URL elicitation gets a tool error; without a consent gate the server doesn't offer the tool at all.

Tests cover acceptance, decline, cancel, an unticked box, invalid contact data, a list changed mid-flow, a client without
elicitation, the URL flow (page confirmed, declined, not opened, timed out), the confirmation page's Host/Origin checks and
escaping, a replayed confirmation and a forged state. A live probe ran the form flow against the real catalog with a fetch guard
that blocks every POST and Merkliste request.

### Handoff to the catalog's own order form (clients without elicitation)

Claude Desktop declares **no elicitation** for local extensions (measured: its per-request capabilities only contain the
MCP Apps extension), so no consent channel can run there, and `submit_reservation_request` refuses. Instead,
`open_order_form` hands the reservation list to the user's browser:

- The client plans the steps (`planOrderFormHandoff`): fresh availability check, then the catalog URLs for clear →
  one search per locator → add each game → order form. It sends nothing itself.
- The MCP layer serves a local page (`handoff/pages.ts`, 127.0.0.1, one-time ticket) and opens it in the default browser.
  One click there opens a small **helper window** that runs the preparing steps (clear, searches, adds) and closes; then
  the user's own tab navigates to the final catalog page. This works because a browser's cookies are shared by all its
  windows, so the helper's catalog session is the tab's. The user ends up on the **official** form (or detail page) in
  their tab and submits it themselves (the form can't be prefilled; browser autofill usually covers name and e-mail).
- Each step waits until the helper actually shows the catalog's page (it becomes unreadable for our page) and then
  returns it to a blank page of our own origin. No fixed delays: about 1–2 s for 4 games, correct on slow connections
  too. Every step URL is unique per run, because the catalog lets browsers cache some responses for hours.
- Not possible (tested): a link alone (session only via cookie), an iframe (third-party cookies are blocked or separate),
  a hidden or background window (browsers block pop-unders), opening the helper without a click (pop-up blockers).
- With this path the user, not the server, sends the request, and the server never handles contact data. The Desktop
  extension therefore has no contact settings at all; only `check_updates` remains in its `user_config`.
- Claude Desktop passes the literal `${user_config.x}` for optional settings left empty; the server treats those as unset.

The same mechanism opens a **game's detail page** (`open_game_page`): the client plans search → detail page from the
game's locator, and the shared handoff page (purpose `game`) walks the browser there. Catalog detail links don't work on
their own, because detail pages are bound to the session's last search.

### Clients (verified 2026-10-11)

- **Claude Code** declares form and URL elicitation → form channel.
- **Claude Desktop** (2.31226.1): for local extensions it sends **no elicitation capability** per request (only
  `extensions: { "io.modelcontextprotocol/ui": … }`, i.e. MCP Apps), measured from a real call. Clients in its bundle that do
  declare URL mode serve other features. → `open_order_form` (handoff). Local MCP servers only run in Desktop chat as a
  Desktop Extension (`.mcpb`) or via `claude_desktop_config.json`; plugins with local servers are ignored there.
- Remote connectors (claude.ai web, mobile) would need a hosted server with authentication and per-user state: not planned.

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

## Packaging

- **Claude Desktop:** `.mcpb` Desktop Extension (`pnpm --filter spielebox-mcp pack:mcpb`). tsdown builds a second, self-contained
  bundle (all dependencies inlined, no `node_modules`); the manifest (spec 0.3) maps `user_config.check_updates` to
  `SPIELEBOX_CHECK_UPDATES`. Desktop runs it with its built-in Node.
- **Claude Code and other clients:** `node packages/mcp/dist/index.mjs` with the same env vars.
- **Updates:** manually installed `.mcpb` files don't update themselves (directory extensions would, but the directory no longer
  takes `.mcpb` submissions). The MCP layer (`updates.ts`, distribution concern, not in the client) asks GitHub for the latest
  release once per process, lazily at the first tool call, and appends a one-time note to a tool result; the server instructions
  ask the model to pass it on. Off via `SPIELEBOX_CHECK_UPDATES=false` (`user_config.check_updates`, "Nach Updates suchen", in the extension).
- Updating (verified with Claude Desktop 2.31226.1, 2026-10-11): double-clicking a `.mcpb` with a **higher** `version` offers
  "Aktualisieren"/"Update" (the same version only offers uninstall), and saved `user_config` values survive the update. So every
  build meant for users needs a version bump.
- Install warning: Desktop shows "Installing will grant this extension access to everything on your computer…" for **every**
  extension installed from a file (condition `onDiskPath` in its UI code), independent of manifest, permissions or signature.
  MCPB has no permission model to request less; only directory installs avoid it, and the directory no longer takes `.mcpb`.
- Known Claude Desktop issue: `.mcpb` files show a blank icon in Finder because Desktop registers the type with a `dxt.icns` it
  doesn't ship ([mcpb#302](https://github.com/modelcontextprotocol/mcpb/issues/302)). Not fixable from the bundle side.

## Iterations

1. **v0.1:** client read-only + MCP read tools + tests.
2. **v0.2:** reservation list.
3. **v0.3:** reservation request with consent. The first real order is a deliberate, user-approved test that records the success page.
