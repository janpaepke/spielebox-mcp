# Contributing

Thanks for helping! This is an unofficial, independent project (see the note in the [README](README.md)). Please keep that in
mind: be gentle with the catalog's server, and never send real reservation requests from tests or experiments.

## Setup

Requires Node ≥ 22.19 and pnpm.

```sh
pnpm install
pnpm build       # all packages; the MCP package and its tests use the built client
pnpm test
pnpm typecheck
pnpm lint        # Biome
pnpm format      # Biome, writes fixes
```

## Layout

| Path | What |
|---|---|
| `packages/client` | `@janpaepke/spielebox-client`: transport (session, throttling, retries), pure HTML parsers, zod schemas, the `SpieleboxClient` facade. No MCP dependency. |
| `packages/mcp` | `spielebox-mcp`: MCP tools that relay to the client, the consent layer (`src/consent`) for reservation requests, the browser handoff (`src/handoff`) and the update notice. |
| `packages/mcp/mcpb` | Manifest of the Claude Desktop extension. |
| `docs/` | How the catalog works ([opac-research.md](docs/opac-research.md)) and the design ([architecture.md](docs/architecture.md)). |

Read [docs/architecture.md](docs/architecture.md) before larger changes. In short: schemas in the client are the single source of
truth; the MCP layer stays a thin relay; presentation of consent lives in channels behind the consent gate.

## Tests

- **Parser tests** run against recorded HTML in `packages/client/test/fixtures`.
- **Client tests** run against `FakeOpac` (`packages/client/test/fake-opac.ts`), which models the catalog's session behavior,
  the Merkliste and the order form.
- **MCP tests** connect a real MCP client in-process; consent tests play the user (form answers, or a "browser" posting the
  local confirmation page).

Two scripts talk to the real catalog. Both only send GET requests for searches and detail pages:

```sh
pnpm --filter @janpaepke/spielebox-client fixtures   # re-record fixtures; some expectations may need updating
pnpm --filter @janpaepke/spielebox-client test:live  # canary: fails when the site's markup or behavior changed
```

The page shown after a successful reservation request has never been recorded; its fixture is synthetic and marked as such.

## Rules for working against the real catalog

- Keep request volume human-like. The client serializes requests and spaces them (500 ms); don't work around that.
- No crawling or mirroring of the catalog.
- Never submit the order form (`orderbasket` POST) or touch the Merkliste (`basket=…`) from tests, scripts or experiments.
  Reservation requests are binding for the person whose data is sent. Test that path against `FakeOpac` only.

## Claude Desktop extension

```sh
pnpm --filter spielebox-mcp pack:mcpb   # → packages/mcp/dist/spielebox.mcpb
```

This bundles the server into one file (no `node_modules`), writes the manifest with the package version, validates and packs it.

## Releases

CI (`.github/workflows/ci.yml`) runs build, lint, typecheck and tests on every pull request and push to `main`. To release:

```sh
pnpm release 1.2.3 --dry-run   # checks + what it would do
pnpm release 1.2.3             # bumps both packages, commits, tags v1.2.3, pushes
```

The tag triggers `release.yml`, which runs the checks again, builds `spielebox.mcpb` with a checksum and build provenance, and
publishes a GitHub release with notes from the `feat`/`fix` commits since the previous tag. Installed extensions mention the
new version once in the chat.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) for the subject line. Use the body for *why* and *how*, not for what
the diff already shows.
