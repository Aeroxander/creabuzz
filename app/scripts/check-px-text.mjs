import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPxTextCheck } from "../../scripts/check-px-text-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

// Readable text uses rem tokens only (stock text-base/sm/xs and the text-2xs meta token), so it follows the reader's
// font size and zoom.
const rules = [{ root: "src", extensions: new Set([".ts", ".tsx", ".css"]) }];

await runPxTextCheck({
  projectRoot,
  rules,
  overrides: new Set([]),
  label: "App",
  scriptPath: "app/scripts/check-px-text.mjs",
});
