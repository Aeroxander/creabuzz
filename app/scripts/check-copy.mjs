import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runCopyCheck } from "../../scripts/check-copy-core.mjs";
import { APP_COPY_RULES } from "./copy-rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

// Accepted exceptions: one string each, with the reason it may stay. Rewrite the text before adding one.
const allow = [
  {
    file: "../packages/creaton-core/src/account/wallet-proof.ts",
    contains: "NostrSigner(address account,bytes32 npub",
    reason:
      "the EIP-712 type string the wallet link signs (wire format, never shown); moved from web/ in milestone 7",
  },
];

await runCopyCheck({
  ts,
  projectRoot,
  // The app's own screens, and the shared account, relay and record code it shows words from (moved out of web/,
  // whose copy check covered it before the move).
  roots: [
    "src",
    "../packages/creaton-core/src/account",
    "../packages/creaton-core/src/client",
    "../packages/creaton-core/src/social",
    "../packages/creaton-core/src/project",
  ],
  allow,
  label: "App",
  scriptPath: "app/scripts/check-copy.mjs",
  extraRules: APP_COPY_RULES,
});
