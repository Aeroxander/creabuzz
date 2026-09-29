#!/usr/bin/env node
// Rewrites the two embedded creation-bytecode constants in
// desktop/src/features/launchpad/lib/graduationArtifact.ts from the forge
// artifacts. Run after ANY change to contracts/src/GraduationExecutor.sol,
// contracts/src/hooks/AllowlistHook.sol or their imports:
//
//   cd contracts && forge build && cd .. && node scripts/regen-graduation-artifact.mjs
//
// `forge inspect GraduationExecutor bytecode` prints the same value; reading
// the artifact JSON here also gives the compiler version for the provenance
// header. `desktop/.../graduationArtifact.test.mjs` fails when the constants and
// the artifacts disagree, so a stale embed cannot ship.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(
  repoRoot,
  "desktop/src/features/launchpad/lib/graduationArtifact.ts",
);

/** foundry >= 1.0 writes `out/<File>.sol/<Contract>.json`. */
function artifact(file, contract) {
  const path = resolve(repoRoot, `contracts/out/${file}/${contract}.json`);
  if (!existsSync(path)) {
    console.error(`missing ${path} — run \`forge build\` in contracts/ first`);
    process.exit(1);
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  const object = json.bytecode?.object;
  if (typeof object !== "string" || !/^0x[0-9a-f]+$/.test(object)) {
    console.error(`${path}: no creation bytecode`);
    process.exit(1);
  }
  return { object, solc: json.metadata?.compiler?.version ?? "unknown" };
}

const executor = artifact("GraduationExecutor.sol", "GraduationExecutor");
const hook = artifact("AllowlistHook.sol", "AllowlistHook");

let source = readFileSync(target, "utf8");
const replaceConst = (name, value) => {
  const re = new RegExp(`(export const ${name} =\\n  ")0x[0-9a-f]+(";)`);
  if (!re.test(source)) {
    console.error(`could not find ${name} in ${target}`);
    process.exit(1);
  }
  source = source.replace(re, `$1${value}$2`);
};
replaceConst("GRADUATION_EXECUTOR_CREATION_BYTECODE", executor.object);
replaceConst("ALLOWLIST_HOOK_CREATION_BYTECODE", hook.object);
writeFileSync(target, source);
console.log(
  `rewrote ${target}\n  GraduationExecutor solc ${executor.solc}, ${executor.object.length / 2 - 1} bytes\n  AllowlistHook      solc ${hook.solc}, ${hook.object.length / 2 - 1} bytes`,
);
