import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFileSizeCheck } from "../../scripts/check-file-sizes-core.mjs";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

/** Small files: a screen that outgrows this is split into its parts. */
const MAX_LINES = 600;

export const policy = {
  projectRoot,
  rules: [
    {
      root: "src",
      extensions: new Set([".ts", ".tsx", ".css"]),
      maxLines: MAX_LINES,
    },
    { root: "tests", extensions: new Set([".ts"]), maxLines: 1000 },
  ],
  label: "App",
};

if (
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === scriptPath
) {
  await runFileSizeCheck(policy);
}
