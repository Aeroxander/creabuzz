import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runCopyCheck } from "../../scripts/check-copy-core.mjs";
import { WEB_COPY_RULES } from "./copy-rules.mjs";

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
  {
    file: "src/features/identity/ui/PasskeyCeremonyPage.tsx",
    contains: "Nostr key",
    reason:
      "the passkey demo page explains its own key derivation to developers",
  },
  {
    file: "src/features/identity/ui/PasskeyCeremonyPage.tsx",
    contains: "(npub, hex)",
    reason:
      "the passkey demo page explains its own key derivation to developers",
  },
  {
    file: "src/features/identity/lib/wallet-proof.ts",
    contains: "NostrSigner(",
    reason:
      "the typed-data shape a wallet signs; its field names are fixed by the contract, not text on the page",
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
  extraRules: WEB_COPY_RULES,
});
