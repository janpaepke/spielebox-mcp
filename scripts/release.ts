/**
 * Cuts a release: `pnpm release 1.2.3` (add `--dry-run` to run all checks without changing anything).
 *
 * Checks that `main` is clean and in sync with GitHub, runs all checks, sets the version in both packages, commits,
 * tags `v1.2.3` and pushes both. The release workflow then builds the Claude Desktop extension and publishes the release.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd: string, args: string[], quiet = false) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit" })
    ?.toString()
    .trim() ?? "";
const fail = (message: string): never => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = (
  args.find((a) => !a.startsWith("--")) ?? fail("usage: pnpm release <version> [--dry-run], e.g. 0.4.2")
).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" is not a version like 1.2.3`);

const PACKAGES = ["packages/client", "packages/mcp"];
const current = JSON.parse(readFileSync("packages/mcp/package.json", "utf8")).version as string;
// The current version may be released as is, as long as it hasn't been tagged yet.
if (version !== current && !isNewer(version, current)) fail(`${version} is older than the current version ${current}`);

if (run("git", ["branch", "--show-current"], true) !== "main") fail("releases are cut from main");
if (run("git", ["status", "--porcelain"], true)) fail("the working tree has uncommitted changes");
run("git", ["fetch", "--quiet", "origin", "main"], true);
if (run("git", ["rev-parse", "HEAD"], true) !== run("git", ["rev-parse", "origin/main"], true)) {
  fail("main is not in sync with origin/main (pull or push first)");
}
if (run("git", ["tag", "--list", `v${version}`], true)) fail(`tag v${version} already exists`);

console.log(`Releasing v${version} (current: ${current})${dryRun ? " — dry run" : ""}`);
// Checks print one line each; their full output only appears when one fails.
for (const script of ["build", "lint", "typecheck", "test"]) {
  process.stdout.write(`  ${script.padEnd(10)}`);
  const result = spawnSync("pnpm", [script], { encoding: "utf8" });
  if (result.status !== 0) {
    console.log("✗\n");
    process.stdout.write(`${result.stdout}${result.stderr}`);
    fail(`${script} failed; nothing was tagged`);
  }
  const passed = [...result.stdout.matchAll(/Tests\s+(\d+) passed/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  console.log(passed ? `✓ (${passed} tests)` : "✓");
}

const steps: [string, () => void][] = [];
if (version !== current) {
  steps.push([
    `set version ${version} in ${PACKAGES.join(", ")}`,
    () => {
      for (const dir of PACKAGES) execFileSync("npm", ["pkg", "set", `version=${version}`], { cwd: dir });
    },
  ]);
  steps.push([
    `commit "chore: release v${version}"`,
    () => {
      run("git", ["add", ...PACKAGES.map((dir) => `${dir}/package.json`)]);
      run("git", ["commit", "--quiet", "-m", `chore: release v${version}`]);
    },
  ]);
}
steps.push([`tag v${version}`, () => run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`])]);
steps.push([
  `push main and v${version}`,
  () => run("git", ["push", "--quiet", "--atomic", "origin", "main", `v${version}`]),
]);

for (const [label, step] of steps) {
  console.log(`  ${dryRun ? "would " : ""}${label}`);
  if (!dryRun) step();
}
if (dryRun) process.exit(0);

console.log(`\nPushed v${version}. The release workflow builds and publishes it:`);
console.log("https://github.com/janpaepke/spielebox-mcp/actions/workflows/release.yml");

function isNewer(candidate: string, base: string): boolean {
  const parts = (v: string) => v.split(".").map(Number);
  const [a, b] = [parts(candidate), parts(base)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
