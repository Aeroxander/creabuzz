import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWLIST_HOOK_CREATION_BYTECODE,
  encodeAllowlistHookConstructorArgs,
  encodeAllowlistHookDeploy,
  encodeGraduationExecutorConstructorArgs,
  encodeGraduationExecutorDeploy,
  GRADUATION_EXECUTOR_CREATION_BYTECODE,
  MAX_RESERVE_BPS,
  predictCreateAddress,
} from "./graduationArtifact.ts";

// ---------------------------------------------------------------------------
// Golden vectors (fresh `cast` output; do not hand-edit hex).
// ---------------------------------------------------------------------------

// `cast abi-encode "constructor(address,uint16)" 0x1111111111111111111111111111111111111111 4000`
const CAST_EXECUTOR_CONSTRUCTOR =
  "0x" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000fa0";

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

function artifactBytecode(relPath, t) {
  const url = new URL(`../../../../../${relPath}`, import.meta.url);
  const path = fileURLToPath(url);
  if (!existsSync(path)) {
    t.skip(`artifact not built: ${relPath}`);
    return null;
  }
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  return artifact.bytecode.object;
}

test("GraduationExecutor pinned bytecode matches contracts/out artifact", (t) => {
  const bytecode = artifactBytecode(
    "contracts/out/GraduationExecutor.sol/GraduationExecutor.json",
    t,
  );
  if (bytecode === null) return;
  assert.equal(GRADUATION_EXECUTOR_CREATION_BYTECODE, bytecode);
});

test("AllowlistHook pinned bytecode matches contracts/out artifact", (t) => {
  const bytecode = artifactBytecode(
    "contracts/out/hooks/AllowlistHook.sol/AllowlistHook.json",
    t,
  );
  if (bytecode === null) return;
  assert.equal(ALLOWLIST_HOOK_CREATION_BYTECODE, bytecode);
});

test("pinned bytecodes are non-trivial creation code", () => {
  assert.ok(GRADUATION_EXECUTOR_CREATION_BYTECODE.startsWith("0x60"));
  assert.ok(GRADUATION_EXECUTOR_CREATION_BYTECODE.length > 2000);
  assert.ok(ALLOWLIST_HOOK_CREATION_BYTECODE.startsWith("0x60"));
  assert.ok(ALLOWLIST_HOOK_CREATION_BYTECODE.length > 1000);
});

// ---------------------------------------------------------------------------
// Constructor encoders
// ---------------------------------------------------------------------------

test("GraduationExecutor constructor args match cast abi-encode", () => {
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
  // GraduationExecutor.sol:68-73 — OnlyTreasury(address(0)) / BadReserveBps.
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
