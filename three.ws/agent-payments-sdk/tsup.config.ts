// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "evm/index": "src/evm/index.ts",
    "solana/index": "src/solana/index.ts",
    "solana/legacy-agent-payments/index": "src/solana/legacy-agent-payments/index.ts",
    "solana/solana-agent-kit/index": "src/solana/solana-agent-kit/index.ts",
    "x402/index": "src/x402/index.ts",
    "a2a-helpers": "src/a2a-helpers.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  // Sourcemaps in dev builds; omitted from the published (prod) bundle to keep
  // the npm tarball lean — set TSUP_SOURCEMAP=false (see the build:prod script).
  sourcemap: process.env.TSUP_SOURCEMAP !== "false",
  clean: true,
  splitting: false,
  treeshake: true,
});
