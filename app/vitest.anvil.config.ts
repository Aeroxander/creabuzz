import { defineConfig } from "vitest/config";

// Milestone 7's chain loop (tests/anvil): Node, not a page, one file at a time, against the anvil that
// `scripts/m7-chain-loop.sh` starts (M7_ANVIL_RPC). Skipped when no chain is given.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/anvil/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
