# spielebox-mcp

**Unofficial** tools that let AI assistants like Claude use the online catalog of the
[WIENXTRA-Spielebox](https://www.wienxtra.at/spielebox/), Austria's largest board game library in Vienna: search ~9000 games,
check what's available right now, and send a reservation request for pickup.

> [!IMPORTANT]
> This is an independent project by a private individual. It is **not** an official WIENXTRA service and is not affiliated
> with WIENXTRA. See [Legal notice](#legal-notice--rechtliche-hinweise).

## What you can ask

- *"Which cooperative games for 4 players, suitable for a 10-year-old, are available at the Spielebox right now?"*
- *"Is Flügelschlag available? How many copies?"*
- *"What's new at the Spielebox?"*
- *"Put Planet Unknown and Colt Express on my reservation list and reserve them."*

The assistant searches the catalog, filters by players, age, play time and availability, looks up the status of each copy, and
can collect games on a reservation list. Reserving always asks you first (see [Reservation requests](#reservation-requests)).

## Install

### Claude Desktop

1. Download `spielebox.mcpb` from the [latest release](https://github.com/janpaepke/spielebox-mcp/releases/latest).
2. Double-click it, or drag it into Claude Desktop (*Settings → Extensions*), and confirm the installation.
3. Optional: enter your name, e-mail and phone in the extension's settings. They only prefill the confirmation of reservation
   requests.

Updates: when a new version is out, the assistant tells you once in the chat. Download the new `spielebox.mcpb` and double-click
it again.

No other software is needed: Claude Desktop brings its own Node.js.

### Claude Code

Build from source (Node ≥ 22.19 and pnpm), then register the server:

```sh
git clone https://github.com/janpaepke/spielebox-mcp.git && cd spielebox-mcp
pnpm install && pnpm build
claude mcp add spielebox \
  -e SPIELEBOX_FIRST_NAME=… -e SPIELEBOX_LAST_NAME=… -e SPIELEBOX_EMAIL=… -e SPIELEBOX_PHONE=… \
  -- node "$(pwd)/packages/mcp/dist/index.mjs"
```

The `SPIELEBOX_*` variables are optional.

### Other MCP clients

Any MCP client that runs local (stdio) servers works: run `node packages/mcp/dist/index.mjs`, optionally with the `SPIELEBOX_*`
environment variables above. Reservation requests need a client that supports MCP elicitation (form or URL mode).

## Tools

| Tool | What it does |
|---|---|
| `search_games` | Search by term, with filters for players, age, play time, keyword and availability. |
| `get_games` | Full details for up to 10 games: description, keywords, play time, availability of each copy. |
| `list_filters` | Keywords (e.g. *Kooperationsspiele*, *ausgezeichnet*), player counts, ages and play times for a term. |
| `list_new_games` | Recently added games. |
| `reservation_list_add` / `_remove` / `_show` / `_clear` | A list of games for your next reservation request. It lives only in the running server, not on the catalog. |
| `submit_reservation_request` | Sends the reservation list to the Spielebox, after your confirmation. |

## Reservation requests

Reserving is binding for you, so nothing is sent without your explicit confirmation:

- **Claude Code** shows a form with the games, your contact details and the wording of the Spielebox's order form. Claude Code
  also asks for permission on every call of this tool.
- **Claude Desktop** opens a confirmation page in your browser (served locally from your own computer) with the same content.

Before sending, availability is checked again, and the request only goes out if it contains exactly the games you confirmed.
A sent request is not yet a booking: the Spielebox staff prepare the games and confirm by e-mail. Their usual rules apply
(order at least a day before pickup; pick up within a few working days).

## Good to know

- **Search** matches a contiguous piece of text in titles, authors, descriptions and keywords, at least 3 characters, no AND/OR.
  Search for one distinctive word (*"flügelschlag"*) or part of the title (*"die siedler"*).
- **Availability** changes all the time; results show when they were read.
- **The catalog has no API.** This project reads the same web pages you would see in a browser. When the Spielebox changes its
  website, things can break until this project is updated.
- **Gentle by design:** one request at a time, at least 500 ms apart, only for what you ask. No crawling, no copies of the catalog.

## Legal notice / Rechtliche Hinweise

**Unofficial project.** spielebox-mcp is an independent, non-commercial open-source project by a private individual. It is not an
official WIENXTRA service and is not affiliated with, endorsed, authorised or sponsored by WIENXTRA, the WIENXTRA-Spielebox or
the City of Vienna. "WIENXTRA" and "WIENXTRA-Spielebox" are names or trademarks of their owners and are used here only to
identify the catalogue this software works with. Please send questions about games, lending and reservations to the Spielebox;
report bugs in this software [here as an issue](https://github.com/janpaepke/spielebox-mcp/issues), not to the Spielebox.

**No warranty.** The software is provided free of charge. Catalogue data and availability may be incomplete, outdated or wrong,
and the software may stop working at any time, for example when the catalogue website changes. A reservation request is sent
only after you explicitly confirm it, goes directly to the Spielebox, and only becomes a reservation once the Spielebox confirms
it. Warranty and liability are governed by the [license](LICENSE) to the extent permitted by law.

**Privacy.** The software runs locally on your computer. Your contact details are stored only in your local configuration and are
sent directly to WIENXTRA only when you confirm a reservation request; WIENXTRA's [privacy policy](https://wienxtra.at/datenschutz)
applies to that data. The developer receives no data. Search queries and results, and contact details entered in your AI
assistant's confirmation form, pass through your AI assistant and are subject to its provider's terms. To tell you about new
versions, the software asks GitHub once per start (at the first use) for the latest release; GitHub sees your IP address, nothing
else is sent. You can turn this off in the extension's settings ("Check for updates").

<details lang="de">
<summary>Deutsch</summary>

**Inoffizielles Projekt.** spielebox-mcp ist ein unabhängiges, nicht-kommerzielles Open-Source-Projekt einer Privatperson. Es ist
kein offizielles Angebot von WIENXTRA und steht in keiner Verbindung zu WIENXTRA, der WIENXTRA-Spielebox oder der Stadt Wien; es
wird von diesen weder unterstützt noch autorisiert oder gesponsert. „WIENXTRA“ und „WIENXTRA-Spielebox“ sind Namen bzw. Marken
ihrer Inhaber und werden hier nur verwendet, um anzugeben, mit welchem Online-Katalog das Programm funktioniert. Fragen zu
Spielen, Ausleihe und Reservierungen richten Sie bitte an die Spielebox, Fehler dieses Programms dagegen
[als Issue hier](https://github.com/janpaepke/spielebox-mcp/issues) und nicht an die Spielebox.

**Ohne Gewähr.** Die Software wird unentgeltlich zur Verfügung gestellt. Katalogdaten und Verfügbarkeiten können unvollständig,
veraltet oder falsch sein, und das Programm kann jederzeit ausfallen, etwa wenn sich die Website des Katalogs ändert. Eine
Reservierungsanfrage wird nur nach Ihrer ausdrücklichen Bestätigung gesendet, geht direkt an die Spielebox und wird erst zur
Reservierung, wenn die Spielebox sie bestätigt. Gewährleistung und Haftung richten sich nach der [Lizenz](LICENSE), soweit
gesetzlich zulässig.

**Datenschutz.** Das Programm läuft lokal auf Ihrem Rechner. Ihre Kontaktdaten werden nur in Ihrer lokalen Konfiguration
gespeichert und nur bei einer von Ihnen bestätigten Reservierungsanfrage direkt an WIENXTRA übermittelt; für diese Daten gilt die
[Datenschutzerklärung von WIENXTRA](https://wienxtra.at/datenschutz). Der Entwickler erhält keine Daten. Suchanfragen und
Ergebnisse sowie Kontaktdaten, die Sie im Bestätigungsformular Ihres KI-Assistenten eingeben, laufen über Ihren KI-Assistenten und
unterliegen den Bedingungen von dessen Anbieter. Um Sie über neue Versionen zu informieren, fragt das Programm einmal pro Start (bei
der ersten Verwendung) bei GitHub nach der neuesten Version; GitHub sieht dabei Ihre IP-Adresse, sonst wird nichts übermittelt.
Sie können das in den Einstellungen der Erweiterung abschalten („Check for updates“).

</details>

## Contributing

What's planned: [ROADMAP.md](ROADMAP.md). How to help: [CONTRIBUTING.md](CONTRIBUTING.md). Design and background: [docs/architecture.md](docs/architecture.md) and
[docs/opac-research.md](docs/opac-research.md).

## License

[MIT](LICENSE). The Claude Desktop extension bundles third-party packages; their licenses are included in the bundle
(`THIRD_PARTY_LICENSES.txt`).
