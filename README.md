# spielebox-mcp

A typed client and an MCP server for the [WIENXTRA-Spielebox](https://www.wienxtra.at/spielebox/) online catalog
([opac.wienxtra.at](https://opac.wienxtra.at/?location=sb)), Austria's largest board game library.

The catalog has no API, so the client scrapes its server-rendered HTML. The MCP server is a thin layer on top of the client.

| Package | Purpose |
|---|---|
| [`packages/client`](packages/client) (`@janpaepke/spielebox-client`) | Search, game details and availability. Later also the reservation list and reservation requests. No MCP dependency. |
| [`packages/mcp`](packages/mcp) (`spielebox-mcp`) | MCP stdio server exposing the client as tools. |

Status: v0.3: search, filters, details, new games, a reservation list, and submitting reservation requests with explicit consent (not yet used against the real catalog). See [docs/architecture.md](docs/architecture.md) for the design and
[docs/opac-research.md](docs/opac-research.md) for how the OPAC works.

## Use with Claude Code

Not published to npm yet. Build it, then register the local build:

```sh
pnpm install && pnpm build
claude mcp add spielebox \
  -e SPIELEBOX_FIRST_NAME=… -e SPIELEBOX_LAST_NAME=… -e SPIELEBOX_EMAIL=… -e SPIELEBOX_PHONE=… \
  -- node "$(pwd)/packages/mcp/dist/index.mjs"
```

The contact variables are optional; they only prefill the confirmation form of a reservation request.

| Tools | Effect |
|---|---|
| `search_games`, `get_games`, `list_filters`, `list_new_games` | Read the catalog. |
| `reservation_list_add` / `_remove` / `_show` / `_clear` | Change a list in the server's memory, not on the catalog. |
| `submit_reservation_request` | **Binding.** Sends the list to the Spielebox. Asks you in a form every time (games, contact data, the order form's wording), and Claude Code additionally asks for permission on every call. Needs an MCP client that supports elicitation forms. |

A sent request is not a booking yet: the Spielebox staff confirm by e-mail when the games are ready.

## Development

Requires Node ≥ 22.19 and pnpm.

```sh
pnpm install
pnpm build       # all packages
pnpm test
pnpm typecheck
pnpm lint        # Biome
pnpm format      # Biome, writes fixes
```

Client tests run against recorded HTML in `packages/client/test/fixtures`. Two scripts talk to the real catalog (GET only):

```sh
pnpm --filter @janpaepke/spielebox-client fixtures   # re-record fixtures; expectations may need updating
pnpm --filter @janpaepke/spielebox-client test:live  # canary: fails when the site's markup or behavior changed
```
