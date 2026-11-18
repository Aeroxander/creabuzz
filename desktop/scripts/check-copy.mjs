import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runCopyCheck } from "../../scripts/check-copy-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Accepted exceptions: one string each, with the reason it may stay.
const allow = [
  {
    file: "src/features/settings/ui/harnessCatalogCopy.ts",
    contains: "Cursor's coding agent",
    reason:
      "names the Cursor tool itself (a harness you can pick), not a citation",
  },
];

await runCopyCheck({
  ts,
  projectRoot,
  roots: ["src"],
  skipDirs: ["testing"],
  skipFiles: ["src/app/routeTree.gen.ts"],
  allow,
  label: "Desktop",
  scriptPath: "desktop/scripts/check-copy.mjs",
});
