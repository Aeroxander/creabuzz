/**
 * Kernel wiring tests — initcode, install packages, nonce layout, and the
 * factory address query. Golden vectors derived with `cast` 1.4.3 (commands
 * inline) against the real `KernelFactory.deploy` ABI
 * (https://github.com/zerodevapp/kernel, `src/KernelFactory.sol`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EthCallRevertError } from "./aa.ts";
import {
  KERNEL_MODULE_TYPE_VALIDATOR,
  buildKernelInitCode,
  buildKernelNonce,
  buildKernelSelfCallData,
  getSenderFromKernelFactory,
  validatorInternalData,
  webAuthnValidatorInstall,
  webAuthnValidatorModuleData,
} from "./aa-kernel.ts";
import { unpackNonce } from "./userop.ts";

test("webAuthnValidatorModuleData matches cast abi-encode of (WebAuthnValidatorData, bytes32)", () => {
  // WebAuthnValidator.onInstall decodes `abi.decode(data, (WebAuthnValidatorData, bytes32))`
  // with WebAuthnValidatorData { uint256 pubKeyX; uint256 pubKeyY; }.
  // $ cast abi-encode "f((uint256,uint256),bytes32)" "(7,9)" 0x00...00
  const expected =
    "0x0000000000000000000000000000000000000000000000000000000000000007" +
    "0000000000000000000000000000000000000000000000000000000000000009" +
    "0000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(webAuthnValidatorModuleData(7n, 9n), expected);
});

test("validatorInternalData follows ValidationManager._initializeValidation", () => {
  // Empty = "installed, no hook, no selectors" (root passkey validator).
  assert.equal(validatorInternalData({}), "0x");
  assert.equal(validatorInternalData({ allowedSelectors: [] }), "0x");
  // Non-empty: bytes20 hook ‖ packed bytes4 selectors (no padding between).
  assert.equal(
    validatorInternalData({
      hook: "0x4444444444444444444444444444444444444444",
    }),
    "0x4444444444444444444444444444444444444444",
  );
  assert.equal(
    validatorInternalData({ allowedSelectors: ["0x12345678", "0x9abcdef0"] }),
    `0x${"00".repeat(20)}123456789abcdef0`,
  );
  assert.equal(
    validatorInternalData({
      hook: "0x4444444444444444444444444444444444444444",
      allowedSelectors: ["0x12345678"],
    }),
    "0x444444444444444444444444444444444444444412345678",
  );
  assert.throws(
    () => validatorInternalData({ hook: "0x1234" }),
    /20-byte address/,
  );
  assert.throws(
    () => validatorInternalData({ allowedSelectors: ["0x1234"] }),
    /4 bytes/,
  );
});

test("webAuthnValidatorInstall builds the validator Install package", () => {
  const install = webAuthnValidatorInstall({
    validator: "0x4444444444444444444444444444444444444444",
    pubKeyX: 7n,
    pubKeyY: 9n,
  });
  assert.equal(install.moduleType, KERNEL_MODULE_TYPE_VALIDATOR);
  assert.equal(install.module, "0x4444444444444444444444444444444444444444");
  assert.equal(install.moduleData, webAuthnValidatorModuleData(7n, 9n));
  assert.equal(install.internalData, "0x");
});

test("buildKernelInitCode matches factory ‖ cast calldata of deploy", () => {
  // $ cast calldata "deploy((uint256,address,bytes,bytes)[],uint256)" \
  //     "[(1,0x4444444444444444444444444444444444444444,0xaabb,0x)]" 5
  // (full vector verified byte-for-byte in userop-abi.test.mjs)
  const expected =
    "0x5555555555555555555555555555555555555555" +
    "0609747b" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000004444444444444444444444444444444444444444" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "aabb000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(
    buildKernelInitCode({
      factory: "0x5555555555555555555555555555555555555555",
      initialPackages: [
        {
          moduleType: 1n,
          module: "0x4444444444444444444444444444444444444444",
          moduleData: "0xaabb",
          internalData: "0x",
        },
      ],
      deployNonce: 5n,
    }),
    expected,
  );
  assert.throws(
    () =>
      buildKernelInitCode({
        factory: "0x1234",
        initialPackages: [],
        deployNonce: 0n,
      }),
    /20-byte address/,
  );
  assert.throws(
    () =>
      buildKernelInitCode({
        factory: "0x5555555555555555555555555555555555555555",
        initialPackages: [],
        deployNonce: 0n,
      }),
    /must not be empty/,
  );
});

test("buildKernelNonce follows Utils.parseNonce byte layout", () => {
  // Root validation, standard mode: the whole nonce is zero.
  assert.equal(buildKernelNonce(), "0x0");
  // [1 byte vMode | 1 byte vType | 20 bytes vId | 2 bytes nonceKey | 8 bytes
  // sequence] — 32 bytes total.
  const validator = "0x1234567890123456789012345678901234567890";
  const nonce = buildKernelNonce({
    validationType: 1,
    validator,
    nonceKey: 0x0203,
    sequence: 0x04050607n,
  });
  assert.equal(
    `0x${nonce.slice(2).padStart(64, "0")}`,
    `0x0001${validator.slice(2)}02030000000004050607`,
  );
  // Cross-binding: the EP-level 192/64 split carries vMode|vType|vId|nonceKey.
  assert.deepEqual(unpackNonce(nonce), {
    key192: BigInt(`0x0001${validator.slice(2)}0203`),
    sequence64: 0x04050607n,
  });
  assert.throws(
    () => buildKernelNonce({ validationType: 0, validator }),
    /takes no validator address/,
  );
  assert.throws(() => buildKernelNonce({ sequence: 1n << 64n }), /eight bytes/);
  assert.throws(() => buildKernelNonce({ nonceKey: 0x10000 }), /two bytes/);
  assert.throws(() => buildKernelNonce({ validationMode: 256 }), /one byte/);
});

test("buildKernelSelfCallData matches cast calldata of execute (self, 0, empty)", () => {
  // executionData = address20 ‖ value32 ‖ raw data (LibERC7579.decodeSingle);
  // mode 0x00..0 = CALLTYPE_SINGLE (byte 0) + EXECTYPE_DEFAULT (byte 1).
  // $ cast calldata "execute(bytes32,bytes)" 0x00..0 0x2222..22‖32×0x00
  const expected =
    "0xe9ae5c53" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000034" +
    "2222222222222222222222222222222222222222000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(
    buildKernelSelfCallData("0x2222222222222222222222222222222222222222"),
    expected,
  );
  assert.throws(() => buildKernelSelfCallData("0x1234"), /20-byte address/);
});

test("getSenderFromKernelFactory decodes the factory getAddress result", async () => {
  const sender = `0x${"22".repeat(20)}`;
  const call = async ({ to, data }) => {
    assert.equal(to, "0x5555555555555555555555555555555555555555");
    assert.ok(data.startsWith("0x0e027ecd"));
    return `0x${"00".repeat(12)}${"22".repeat(20)}`;
  };
  assert.equal(
    await getSenderFromKernelFactory({
      call,
      factory: "0x5555555555555555555555555555555555555555",
      initialPackages: [
        {
          moduleType: 1n,
          module: "0x4444444444444444444444444444444444444444",
          moduleData: "0xaabb",
          internalData: "0x",
        },
      ],
      deployNonce: 5n,
    }),
    sender,
  );
  await assert.rejects(
    () =>
      getSenderFromKernelFactory({
        call: async () => {
          throw new EthCallRevertError("reverted", "0xdeadbeef");
        },
        factory: "0x5555555555555555555555555555555555555555",
        initialPackages: [
          {
            moduleType: 1n,
            module: "0x4444444444444444444444444444444444444444",
            moduleData: "0xaabb",
            internalData: "0x",
          },
        ],
        deployNonce: 5n,
      }),
    /execution reverted|reverted/,
  );
});
