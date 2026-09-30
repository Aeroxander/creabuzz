import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runCopyCheck } from "../../scripts/check-copy-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Accepted exceptions: one string each, with the reason it may stay.
const allow = [
  {
    file: "src/app/routes.ts",
    contains: "/identity-demo",
    reason: "the route definition itself; the page is unlisted and dev-facing",
  },
  {
    file: "src/app/routes/identity-demo.tsx",
    contains: "/identity-demo",
    reason: "the route definition itself; the page is unlisted and dev-facing",
  },
];

await runCopyCheck({
  ts,
  projectRoot,
  roots: ["src"],
  skipFiles: ["src/app/routeTree.gen.ts"],
  allow,
  label: "Web",
  scriptPath: "web/scripts/check-copy.mjs",
});
