/**
 * Packs the Claude Desktop extension: manifest (with the package version), the self-contained server bundle from
 * `pnpm build`, this project's LICENSE and the licenses of all bundled dependencies → `dist/spielebox.mcpb`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const bundle = new URL("build/mcpb/", root);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("mcpb/manifest.json", root), "utf8"));

writeFileSync(new URL("manifest.json", bundle), `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);
copyFileSync(new URL("../../LICENSE", root), new URL("LICENSE", bundle));
writeFileSync(new URL("THIRD_PARTY_LICENSES.txt", bundle), thirdPartyLicenses());

const mcpb = (...args: string[]) => execFileSync("pnpm", ["exec", "mcpb", ...args], { cwd: root, stdio: "inherit" });
mcpb("validate", "build/mcpb/manifest.json");
mcpb("pack", "build/mcpb", "dist/spielebox.mcpb");

type LicensedPackage = { name: string; versions: string[]; paths: string[]; license: string };

/**
 * Production dependencies of this package and of the workspace client (pnpm doesn't follow the workspace link),
 * each with its license text as shipped in the package.
 */
function thirdPartyLicenses(): string {
  const packages = new Map<string, LicensedPackage>();
  for (const dir of [".", "../client"]) {
    const json = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: new URL(dir, root) }).toString();
    for (const list of Object.values(JSON.parse(json) as Record<string, LicensedPackage[]>)) {
      for (const p of list) packages.set(`${p.name}@${p.versions.join(",")}`, p);
    }
  }
  const sections = [...packages.values()]
    .filter((p) => p.name !== "@janpaepke/spielebox-client")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const dir = p.paths[0] ?? "";
      const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      const text = file
        ? readFileSync(join(dir, file), "utf8").trim()
        : `License: ${p.license} (no license file shipped)`;
      return `${p.name}@${p.versions.join(", ")} (${p.license})\n\n${text}`;
    });
  const rule = `\n\n${"-".repeat(78)}\n\n`;
  return `This bundle includes the following third-party packages.${rule}${sections.join(rule)}\n`;
}
