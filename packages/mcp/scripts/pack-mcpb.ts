/**
 * Packs the Claude Desktop extension: manifest (with the package version) + the self-contained server bundle
 * from `pnpm build` → `dist/spielebox.mcpb`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("mcpb/manifest.json", root), "utf8"));

const bundle = new URL("build/mcpb/", root);
writeFileSync(new URL("manifest.json", bundle), `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);

const mcpb = (...args: string[]) => execFileSync("pnpm", ["exec", "mcpb", ...args], { cwd: root, stdio: "inherit" });
mcpb("validate", "build/mcpb/manifest.json");
mcpb("pack", "build/mcpb", "dist/spielebox.mcpb");
