#!/usr/bin/env node
import { SpieleboxClient } from "@janpaepke/spielebox-client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfirmationPages, ConsentGate, FormConsentChannel, UrlConsentChannel } from "./consent/index.ts";
import { createServer } from "./server.ts";

const env = (name: string) => process.env[name] || undefined;

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

serveStdio(() => createServer(client, { consent, contact }));
