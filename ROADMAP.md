# Roadmap

Rough plan, not a promise. Main target: **Claude Desktop**.

## Next

- **First real reservation request** as a deliberate test, to record the catalog's success page and tighten how the response is
  checked (today it's only tested against a stand-in).

## Planned

- **ChatGPT desktop app.** Blocked until local MCP tools reach normal chats there
  ([openai/codex#38162](https://github.com/openai/codex/issues/38162)). Then:
  - a standalone executable, so users don't need Node.js (ChatGPT desktop doesn't bring one), signed and notarized for macOS and
    Windows;
  - a setup guide for *Settings → MCP servers → Add server* (no one-click install there yet);
  - a test of the consent form in ChatGPT (form elicitation works there; protocol 2025-06-18).

## Deferred

- **Confirmation inside the chat** (MCP Apps) for Claude Desktop, instead of the browser handoff to the order form.
- **Automatic updates** through a Claude plugin marketplace (works in Claude Code and Cowork, not in Claude Desktop's chat). Until
  then, the extension tells you in the chat when a new release is out.
- **Remote server** for claude.ai on the web and mobile. Would need hosting, sign-in and per-user state.

## Watching

- Windows' built-in MCP support, which announced `.mcpb` support.
- The blank `.mcpb` icon in Finder, a Claude Desktop issue
  ([modelcontextprotocol/mcpb#302](https://github.com/modelcontextprotocol/mcpb/issues/302)).
