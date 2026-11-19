import { defineConfig } from "vitest/config";

// The chain loops (tests/anvil): Node, not a page, one file at a time, against the anvil that
// `scripts/pot-app-chain-loop.sh` starts (M7_ANVIL_RPC). Skipped when no chain is given.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/anvil/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
