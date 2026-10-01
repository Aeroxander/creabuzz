import { defineConfig } from "@playwright/test";

// Pure-logic tests run in Node through Playwright's TypeScript runner (no
// browser, no dev server), so `@/` imports resolve through tsconfig paths.
export default defineConfig({
  testDir: "./tests/unit",
  reporter: [["list"]],
});
