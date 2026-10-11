#!/usr/bin/env node
import { SpieleboxClient } from "@janpaepke/spielebox-client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";

const client = new SpieleboxClient();
serveStdio(() => createServer(client));
