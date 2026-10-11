# spielebox-mcp

A typed client and an MCP server for the [WIENXTRA-Spielebox](https://www.wienxtra.at/spielebox/) online catalog
([opac.wienxtra.at](https://opac.wienxtra.at/?location=sb)), Austria's largest board game library.

The catalog has no API, so the client scrapes its server-rendered HTML. The MCP server is a thin layer on top of the client.

| Package | Purpose |
|---|---|
| [`packages/client`](packages/client) (`@janpaepke/spielebox-client`) | Search, game details and availability. Later also the reservation list and reservation requests. No MCP dependency. |
| [`packages/mcp`](packages/mcp) (`spielebox-mcp`) | MCP stdio server exposing the client as tools. |

Status: v0.2: search, filters, details, new games and a local reservation list. Submitting reservation requests is not implemented yet. See [docs/architecture.md](docs/architecture.md) for the design and
[docs/opac-research.md](docs/opac-research.md) for how the OPAC works.

## Use with Claude Code

Not published to npm yet. Build it, then register the local build:

```sh
pnpm install && pnpm build
claude mcp add spielebox -- node "$(pwd)/packages/mcp/dist/index.mjs"
```

Tools: `search_games`, `get_games`, `list_filters`, `list_new_games`, and `reservation_list_add` / `_remove` / `_show` / `_clear`.
None of them changes anything on the catalog: the reservation list lives in the server's memory.

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
