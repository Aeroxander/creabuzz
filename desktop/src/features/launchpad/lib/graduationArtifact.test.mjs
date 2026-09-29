import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWLIST_HOOK_CREATION_BYTECODE,
  DEFAULT_RESERVE_LOCK_SECONDS,
  encodeAllowlistHookConstructorArgs,
  encodeAllowlistHookDeploy,
  encodeGraduationExecutorConstructorArgs,
  encodeGraduationExecutorDeploy,
  GRADUATION_EXECUTOR_CREATION_BYTECODE,
  MAX_RESERVE_BPS,
  MAX_RESERVE_LOCK_SECONDS,
  MIN_RESERVE_LOCK_SECONDS,
  predictCreateAddress,
} from "./graduationArtifact.ts";

// ---------------------------------------------------------------------------
// Golden vectors (fresh `cast` output; do not hand-edit hex).
// ---------------------------------------------------------------------------

// `cast abi-encode "constructor(address,uint16,uint64)" 0x1111111111111111111111111111111111111111 4000 2592000`
const CAST_EXECUTOR_CONSTRUCTOR =
  "0x" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000fa0" +
  "0000000000000000000000000000000000000000000000000000000000278d00";

// `cast abi-encode "constructor(address,uint16,uint64)" 0x1111111111111111111111111111111111111111 0 86400`
const CAST_EXECUTOR_CONSTRUCTOR_MIN_LOCK =
  "0x" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000015180";

// `cast abi-encode "constructor(address,uint128)" 0x1111111111111111111111111111111111111111 1000000`
const CAST_HOOK_CONSTRUCTOR =
  "0x" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "00000000000000000000000000000000000000000000000000000000000f4240";

const TREASURY = "0x1111111111111111111111111111111111111111";
const DEPLOYER = "0x2222222222222222222222222222222222222222";

// `cast compute-address --nonce <n> 0x2222222222222222222222222222222222222222`
const CAST_CREATE_ADDRESSES = [
  [0n, "0x659b375d76a8e9a2c68da8818022d6561aa60845"],
  [1n, "0x894bcfd2eed71b2082101dc85f86865824efb62d"],
  [7n, "0x20dd5002165c43bd664225d1592939b0dfdae073"],
  [127n, "0x94d8faba855284d49ef42fafe3357f57a8dedf87"],
  [128n, "0xed50a8106e29e03ec86c56c7ad1ae5dd8e51bb9c"],
  [255n, "0xe11ff1895d62cb8d8d6c5aad36e8d62ef2531dcf"],
  [256n, "0xfd81f59141dc1509a3173d7a60e8d58b7beaa177"],
  [65536n, "0xaf051fe6753f99947a3b9db004f91a07014e2e5b"],
  [1000000n, "0xbf80cc2e0497e36e0f4d49540f8bd2bbae089458"],
];

// ---------------------------------------------------------------------------
// Pinned artifact verification (skip gracefully without contracts/out/)
// ---------------------------------------------------------------------------

/**
 * Strip the trailing CBOR metadata (`…a264697066735822<34 bytes>64736f6c63<3
 * bytes>0033`): its last two bytes are the metadata length. It embeds the hash
 * of the compiler input (remapping list, source paths), which legitimately
 * differs between machines; everything before it is the executable creation
 * code and must match byte for byte.
 */
export function withoutMetadata(hex) {
  const body = hex.replace(/^0x/, "");
  const metaLen = Number.parseInt(body.slice(-4), 16);
  assert.ok(
    Number.isInteger(metaLen) && metaLen > 0 && metaLen * 2 + 4 < body.length,
    "bytecode must end in a CBOR metadata length",
  );
  return body.slice(0, body.length - (metaLen * 2 + 4));
}

function artifactBytecode(file, contract, t) {
  const relPath = `contracts/out/${file}/${contract}.json`;
  const path = fileURLToPath(new URL(`../../../../../${relPath}`, import.meta.url));
  if (!existsSync(path)) {
    if (process.env.REQUIRE_CONTRACT_ARTIFACTS === "1") {
      assert.fail(
        `${relPath} is missing but REQUIRE_CONTRACT_ARTIFACTS=1: run \`forge build\` in contracts/ first`,
      );
    }
    t.skip(`artifact not built: ${relPath}`);
    return null;
  }
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  return artifact.bytecode.object;
}

test("GraduationExecutor pinned bytecode matches contracts/out artifact", (t) => {
  const bytecode = artifactBytecode(
    "GraduationExecutor.sol",
    "GraduationExecutor",
    t,
  );
  if (bytecode === null) return;
  assert.equal(
    withoutMetadata(GRADUATION_EXECUTOR_CREATION_BYTECODE),
    withoutMetadata(bytecode),
    "graduationArtifact.ts is stale: run `forge build` then `node scripts/regen-graduation-artifact.mjs`",
  );
});

test("AllowlistHook pinned bytecode matches contracts/out artifact", (t) => {
  const bytecode = artifactBytecode("AllowlistHook.sol", "AllowlistHook", t);
  if (bytecode === null) return;
  assert.equal(
    withoutMetadata(ALLOWLIST_HOOK_CREATION_BYTECODE),
    withoutMetadata(bytecode),
    "graduationArtifact.ts is stale: run `forge build` then `node scripts/regen-graduation-artifact.mjs`",
  );
});

test("withoutMetadata drops exactly the CBOR trailer", () => {
  // 3 code bytes + 2-byte-length-prefixed metadata of 4 bytes (0x0004).
  assert.equal(withoutMetadata("0x6001aaaaaaaa0004"), "6001");
  assert.throws(() => withoutMetadata("0x60"), /metadata length/);
});

// Function selectors are PUSH4 constants in the dispatcher (`cast sig`). A
// stale embed — built before the one-auction bind, the reserve lock or the hook's
// auction gate existed — lacks them, so this fails even where `contracts/out` is
// not built.
test("the pinned executor creation code carries the bind + reserve-lock surface", () => {
  for (const [sig, selector] of [
    ["bindAuction(address)", "ccd616ae"],
    ["boundAuction()", "769956cb"],
    ["withdrawStuckReserve(address)", "eb6ba94e"],
    ["reserveLockSeconds()", "1c443c4c"],
    ["reserveUnlockAt(address)", "193c206f"],
  ]) {
    assert.ok(
      GRADUATION_EXECUTOR_CREATION_BYTECODE.includes(selector),
      `executor creation code lacks ${sig} (0x${selector}) — regenerate graduationArtifact.ts`,
    );
  }
});

test("the pinned hook creation code carries the auction gate", () => {
  assert.ok(
    ALLOWLIST_HOOK_CREATION_BYTECODE.includes("b8c6f579"),
    "hook creation code lacks setAuction(address) — regenerate graduationArtifact.ts",
  );
});

// ---------------------------------------------------------------------------
// Constructor encoders
// ---------------------------------------------------------------------------

test("GraduationExecutor constructor args match cast abi-encode", () => {
  assert.equal(
    encodeGraduationExecutorConstructorArgs(TREASURY, 4000, 2_592_000),
    CAST_EXECUTOR_CONSTRUCTOR,
  );
  assert.equal(
    encodeGraduationExecutorConstructorArgs(TREASURY, 0, MIN_RESERVE_LOCK_SECONDS),
    CAST_EXECUTOR_CONSTRUCTOR_MIN_LOCK,
  );
});

test("the default reserve lock is 30 days", () => {
  assert.equal(DEFAULT_RESERVE_LOCK_SECONDS, 2_592_000);
  assert.equal(
    encodeGraduationExecutorConstructorArgs(TREASURY, 4000),
    CAST_EXECUTOR_CONSTRUCTOR,
  );
});

test("GraduationExecutor deploy data = pinned bytecode + constructor args", () => {
  assert.equal(
    encodeGraduationExecutorDeploy(TREASURY, 4000),
    GRADUATION_EXECUTOR_CREATION_BYTECODE + CAST_EXECUTOR_CONSTRUCTOR.slice(2),
  );
});

test("AllowlistHook constructor args match cast abi-encode", () => {
  assert.equal(
    encodeAllowlistHookConstructorArgs(TREASURY, 1_000_000n),
    CAST_HOOK_CONSTRUCTOR,
  );
});

test("AllowlistHook deploy data = pinned bytecode + constructor args", () => {
  assert.equal(
    encodeAllowlistHookDeploy(TREASURY, 1_000_000n),
    ALLOWLIST_HOOK_CREATION_BYTECODE + CAST_HOOK_CONSTRUCTOR.slice(2),
  );
});

test("constructor encoders reject the constructors' own bounds", () => {
  // GraduationExecutor constructor — OnlyTreasury(address(0)) / BadReserveBps.
  assert.throws(
    () => encodeGraduationExecutorConstructorArgs("0x0".padEnd(42, "0"), 4000),
    /zero address/,
  );
  assert.throws(
    () =>
      encodeGraduationExecutorConstructorArgs(TREASURY, MAX_RESERVE_BPS + 1),
    /reserveBps/,
  );
  assert.throws(
    () => encodeGraduationExecutorConstructorArgs(TREASURY, -1),
    /reserveBps/,
  );
  assert.throws(
    () => encodeGraduationExecutorConstructorArgs("nope", 4000),
    /address/,
  );
  // GraduationExecutor.BadReserveLock: outside [1 day, 365 days].
  assert.throws(
    () =>
      encodeGraduationExecutorConstructorArgs(
        TREASURY,
        4000,
        MIN_RESERVE_LOCK_SECONDS - 1,
      ),
    /reserveLockSeconds/,
  );
  assert.throws(
    () => encodeGraduationExecutorConstructorArgs(TREASURY, 4000, 0),
    /reserveLockSeconds/,
  );
  assert.throws(
    () =>
      encodeGraduationExecutorConstructorArgs(
        TREASURY,
        4000,
        MAX_RESERVE_LOCK_SECONDS + 1,
      ),
    /reserveLockSeconds/,
  );
  assert.doesNotThrow(() =>
    encodeGraduationExecutorConstructorArgs(
      TREASURY,
      4000,
      MAX_RESERVE_LOCK_SECONDS,
    ),
  );
  assert.throws(
    () => encodeAllowlistHookConstructorArgs(TREASURY, 1n << 128n),
    /uint128/,
  );
});

// ---------------------------------------------------------------------------
// CREATE address prediction (deploy-step idempotency guard)
// ---------------------------------------------------------------------------

test("predictCreateAddress matches cast compute-address", () => {
  for (const [nonce, expected] of CAST_CREATE_ADDRESSES) {
    assert.equal(
      predictCreateAddress(DEPLOYER, nonce),
      expected,
      `nonce ${nonce}`,
    );
  }
});

test("predictCreateAddress validates its inputs", () => {
  assert.throws(() => predictCreateAddress("nope", 0n), /address/);
  assert.throws(() => predictCreateAddress(DEPLOYER, -1n), /non-negative/);
});
