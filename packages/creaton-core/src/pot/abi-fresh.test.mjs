// The ABIs in this package must be exactly what the contracts build to now. This builds contracts/pot fresh (sources only,
// into a throwaway folder, so nothing in the tree is touched), reads each ABI from forge's own output and compares the
// text `scripts/pot-app-abi.mjs` would write with the committed `abis.generated.ts`.
//
// It needs `forge` (on PATH, or FORGE_BIN). Without it the test is SKIPPED, and says so: a skip is not a pass, run
// `node scripts/pot-app-abi.mjs --check` on a machine that has the build output.
// Run with: node --experimental-strip-types --test src/pot/abi-fresh.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GENERATED_FILE,
  readAbis,
  render,
} from "../../../../scripts/pot-app-abi.mjs";

const POT = fileURLToPath(
  new URL("../../../../contracts/pot", import.meta.url),
);
const FORGE = process.env.FORGE_BIN || "forge";

const version = spawnSync(FORGE, ["--version"], { encoding: "utf8" });
const haveForge = !version.error && version.status === 0;

test("the ABIs in the package are what a fresh build of contracts/pot gives", {
  skip: haveForge
    ? false
    : "SKIPPED: forge is not installed (put it on PATH or set FORGE_BIN). Nothing was compared.",
  timeout: 25 * 60 * 1000,
}, () => {
  // A fixed throwaway folder, so a second run builds only what changed.
  const work = join(tmpdir(), "creaton-pot-abi-check");
  mkdirSync(work, { recursive: true });
  const out = join(work, "out");
  const built = spawnSync(
    FORGE,
    [
      "build",
      "--root",
      POT,
      "--skip",
      "test",
      "--skip",
      "script",
      "--out",
      out,
      "--cache-path",
      join(work, "cache"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(
    built.status,
    0,
    `forge build failed:\n${built.stdout}\n${built.stderr}`,
  );
  const fresh = render(readAbis(out));
  const committed = readFileSync(GENERATED_FILE, "utf8");
  assert.equal(
    committed,
    fresh,
    "abis.generated.ts differs from a fresh build of contracts/pot: run `node scripts/pot-app-abi.mjs` and commit it",
  );
});
