import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPxTextCheck } from "../../scripts/check-px-text-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// The browser client's readable text must use a rem-based token — the stock
// `text-base`/`text-sm`/`text-xs` scale or the `text-2xs`/`text-3xs` meta-text
// tokens — so it follows the reader's font-size setting and zoom instead of
// being frozen at a pixel size. The desktop app has had this guard since the
// zoom regression (PR #891); the web client had drifted to arbitrary literals.
const rules = [
  {
    root: "src",
    extensions: new Set([".ts", ".tsx", ".css"]),
  },
];

// Decorative glyphs sized to a fixed box rather than to text.
const overrides = new Set([]);

await runPxTextCheck({
  projectRoot,
  rules,
  overrides,
  label: "Web",
  scriptPath: "web/scripts/check-px-text.mjs",
});
