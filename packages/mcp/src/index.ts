#!/usr/bin/env node
import { SpieleboxClient } from "@janpaepke/spielebox-client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json" with { type: "json" };
import { ConfirmationPages, ConsentGate, FormConsentChannel, UrlConsentChannel } from "./consent/index.ts";
import { env } from "./env.ts";
import { openInBrowser } from "./handoff/open-browser.ts";
import { HandoffPages } from "./handoff/pages.ts";
import { createServer } from "./server.ts";
import { UpdateCheck } from "./updates.ts";

// Shared by all server instances: the SDK may build one per request, while the client and consent flows span several.
const client = new SpieleboxClient();
const consent = new ConsentGate({
  // Prefer an in-client form (e.g. Claude Code); fall back to a local page in the browser (e.g. Claude Desktop).
  channels: [new FormConsentChannel(), new UrlConsentChannel(new ConfirmationPages())],
});
const contact = {
  firstName: env("SPIELEBOX_FIRST_NAME"),
  lastName: env("SPIELEBOX_LAST_NAME"),
  email: env("SPIELEBOX_EMAIL"),
  phone: env("SPIELEBOX_PHONE"),
};

const updates =
  env("SPIELEBOX_CHECK_UPDATES") === "false"
    ? undefined
    : new UpdateCheck({
        currentVersion: pkg.version,
        repository: "janpaepke/spielebox-mcp",
        howToUpdate:
          env("SPIELEBOX_DISTRIBUTION") === "mcpb"
            ? "Download spielebox.mcpb from the release page and double-click it to update:"
            : "Release notes:",
      });

// For clients that can't show a confirmation (e.g. Claude Desktop): the user submits on the catalog's own order form.
const handoff = { pages: new HandoffPages(), openBrowser: openInBrowser };

const log = (message: string) => console.error(`[spielebox] ${message}`);

serveStdio(() => createServer(client, { consent, contact, updates, handoff, log }));
