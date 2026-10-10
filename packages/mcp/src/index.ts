#!/usr/bin/env node
import { SpieleboxClient } from "@janpaepke/spielebox-client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";

const env = (name: string) => process.env[name] || undefined;

const client = new SpieleboxClient();
const contact = {
  firstName: env("SPIELEBOX_FIRST_NAME"),
  lastName: env("SPIELEBOX_LAST_NAME"),
  email: env("SPIELEBOX_EMAIL"),
  phone: env("SPIELEBOX_PHONE"),
};
serveStdio(() => createServer(client, { contact }));
