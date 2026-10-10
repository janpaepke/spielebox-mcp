# spielebox-mcp

A typed client and an MCP server for the [WIENXTRA-Spielebox](https://www.wienxtra.at/spielebox/) online catalog
([opac.wienxtra.at](https://opac.wienxtra.at/?location=sb)), Austria's largest board game library.

The catalog has no API, so the client scrapes its server-rendered HTML. The MCP server is a thin layer on top of the client.

| Package | Purpose |
|---|---|
| [`packages/client`](packages/client) (`@janpaepke/spielebox-client`) | Search, game details and availability. Later also the reservation list and reservation requests. No MCP dependency. |
| [`packages/mcp`](packages/mcp) (`spielebox-mcp`) | MCP stdio server exposing the client as tools. |

Status: early development. See [docs/architecture.md](docs/architecture.md) for the design and
[docs/opac-research.md](docs/opac-research.md) for how the OPAC works.

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
