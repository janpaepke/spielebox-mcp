import { defineConfig } from "tsdown";

export default defineConfig([
  // The package: dependencies stay external, installed by the package manager.
  {
    entry: ["src/index.ts"],
    platform: "node",
    dts: false,
  },
  // The Desktop extension (.mcpb): one self-contained file, since the bundle ships without node_modules.
  {
    entry: { index: "src/index.ts" },
    outDir: "build/mcpb/server",
    platform: "node",
    dts: false,
    clean: true,
    deps: { alwaysBundle: [/.*/], onlyBundle: false }, // bundling everything is the point; no hint listing it
  },
]);
