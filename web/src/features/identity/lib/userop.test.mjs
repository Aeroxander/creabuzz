/**
 * ERC-4337 v0.8 UserOperation hashing — golden vectors.
 *
 * The hash is an EIP-712 typed message hash (EntryPoint v0.8.0
 * `getUserOpHash` = `MessageHashUtils.toTypedDataHash(getDomainSeparatorV4(),
 * userOp.hash(...))`; canonical ERC-4337 "Support for EIP-712 signatures").
 * Every constant and the full hash were derived stepwise with `cast` 1.4.3;
 * the commands are recorded inline. A derivation change must fail this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  EIP712_DOMAIN_NAME_HASH,
  EIP712_DOMAIN_TYPEHASH,
  EIP712_DOMAIN_VERSION_HASH,
  PACKED_USEROP_TYPEHASH,
  eip712DomainSeparator,
  getUserOpHash,
  hashPackedUserOperation,
  isEip7702InitCode,
  keccak256,
  packAccountGasLimits,
  packGasFees,
  packNonce,
  packUints,
  toTypedDataHash,
  unpackNonce,
  unpackUints,
} from "./userop.ts";

const ENTRY_POINT = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 31337n;

const goldenOp = {
  sender: "0x2222222222222222222222222222222222222222",
  nonce: "0x0",
  initCode: "0xdeadbeef",
  callData: "0xc0ffee",
  accountGasLimits: packUints(3n, 5n),
  preVerificationGas: "0x5208",
  gasFees: packUints(1n, 2n),
  paymasterAndData: "0x",
};

test("typehash constants match cast keccak of the canonical strings", () => {
  // $ cast keccak "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)"
  assert.equal(
    PACKED_USEROP_TYPEHASH,
    "0x29a0bca4af4be3421398da00295e58e6d7de38cb492214754cb6a47507dd6f8e",
  );
  // $ cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  assert.equal(
    EIP712_DOMAIN_TYPEHASH,
    "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
  );
  // $ cast keccak "ERC4337"   (EntryPoint.sol DOMAIN_NAME)
  assert.equal(
    EIP712_DOMAIN_NAME_HASH,
    "0x364da28a5c92bcc87fe97c8813a6c6b8a3a049b0ea0a328fcb0b4f0e00337586",
  );
  // $ cast keccak "1"         (EntryPoint.sol DOMAIN_VERSION)
  assert.equal(
    EIP712_DOMAIN_VERSION_HASH,
    "0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6",
  );
  // Independent binding of the module's own keccak.
  assert.equal(
    keccak256("0x"),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});

test("packUints/unpackUints pack high-128 ‖ low-128 (UserOperationLib.unpackUints)", () => {
  // $ python3 -c "print('0x{:064x}'.format((3 << 128) | 5))"
  assert.equal(packUints(3n, 5n), `0x${"0".repeat(31)}3${"0".repeat(31)}5`);
  assert.deepEqual(unpackUints(packUints(3n, 5n)), { high128: 3n, low128: 5n });
  assert.deepEqual(
    unpackUints(
      packAccountGasLimits({
        verificationGasLimit: 300000n,
        callGasLimit: 100000n,
      }),
    ),
    { high128: 300000n, low128: 100000n },
  );
  assert.deepEqual(
    unpackUints(
      packGasFees({
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: 2000000000n,
      }),
    ),
    { high128: 1n, low128: 2000000000n },
  );
  assert.throws(() => packUints(1n << 128n, 0n), /fit in 128/);
  assert.throws(() => packUints(0n, 1n << 128n), /fit in 128/);
});

test("packNonce/unpackNonce pack the 192-bit key ‖ 64-bit sequence", () => {
  // NonceManager.getNonce: `sequence | (key << 64)`; the packed word is the
  // raw concatenation of the 24-byte key and the 8-byte sequence.
  const key192 = BigInt("0x0102030405060708090a0b0c0d0e0f101112131415161718");
  const sequence = BigInt("0xdeadbeefcafebabe");
  assert.equal(
    packNonce(key192, sequence),
    "0x0102030405060708090a0b0c0d0e0f101112131415161718deadbeefcafebabe",
  );
  assert.deepEqual(unpackNonce(packNonce(key192, sequence)), {
    key192,
    sequence64: sequence,
  });
  assert.equal(packNonce(0n, 0n), `0x${"00".repeat(32)}`);
  assert.throws(() => packNonce(1n << 192n, 0n), /fit in 192/);
  assert.throws(() => packNonce(0n, 1n << 64n), /fit in 64/);
});

test("hashPackedUserOperation matches the cast-derived struct hash", () => {
  // Derivation (all commands run with `cast` 1.4.3):
  // $ cast keccak 0xdeadbeef  -> 0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1
  // $ cast keccak 0xc0ffee    -> 0x7924f890e12acdf516d6278e342cd34550e3bafe0a3dec1b9c2c3e991733711a
  // $ cast keccak 0x          -> 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
  // $ cast abi-encode "f(bytes32,address,uint256,bytes32,bytes32,bytes32,uint256,bytes32,bytes32)" \
  //     0x29a0bca4af4be3421398da00295e58e6d7de38cb492214754cb6a47507dd6f8e \
  //     0x2222222222222222222222222222222222222222 0x0 \
  //     0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1 \
  //     0x7924f890e12acdf516d6278e342cd34550e3bafe0a3dec1b9c2c3e991733711a \
  //     0x0000000000000000000000000000000300000000000000000000000000000005 21000 \
  //     0x0000000000000000000000000000000100000000000000000000000000000002 \
  //     0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470 \
  //   | cast keccak  -> 0x08eefb1bb6cf58afe201fbfd716022e1734b83e1a74f9ae95e40b6a9be354e28
  assert.equal(
    hashPackedUserOperation(goldenOp),
    "0x08eefb1bb6cf58afe201fbfd716022e1734b83e1a74f9ae95e40b6a9be354e28",
  );
});

test("eip712DomainSeparator matches the cast-derived separator", () => {
  // $ cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" \
  //     0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f \
  //     0x364da28a5c92bcc87fe97c8813a6c6b8a3a049b0ea0a328fcb0b4f0e00337586 \
  //     0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6 \
  //     31337 0x1111111111111111111111111111111111111111 | cast keccak
  assert.equal(
    eip712DomainSeparator(ENTRY_POINT, CHAIN_ID),
    "0xebcf63a674b30c261b63724ecfbfa10afebcd3458b08adceb19071d19ed5ec9d",
  );
  // The separator must move with chainId and verifyingContract.
  assert.notEqual(
    eip712DomainSeparator(ENTRY_POINT, 1n),
    eip712DomainSeparator(ENTRY_POINT, CHAIN_ID),
  );
  assert.notEqual(
    eip712DomainSeparator(
      "0x3333333333333333333333333333333333333333",
      CHAIN_ID,
    ),
    eip712DomainSeparator(ENTRY_POINT, CHAIN_ID),
  );
});

test("getUserOpHash matches the cast-derived EIP-712 typed hash", () => {
  // structHash = 0x08eefb1bb6cf58afe201fbfd716022e1734b83e1a74f9ae95e40b6a9be354e28
  // separator  = 0xebcf63a674b30c261b63724ecfbfa10afebcd3458b08adceb19071d19ed5ec9d
  // $ cast keccak $(cast concat-hex 0x1901 <separator> <structHash>) \
  //   -> 0xd6cacc8eda8775806acb23b07822677a113e5a7bb8fb41e1e840f11f6331d67a
  assert.equal(
    getUserOpHash(goldenOp, ENTRY_POINT, CHAIN_ID),
    "0xd6cacc8eda8775806acb23b07822677a113e5a7bb8fb41e1e840f11f6331d67a",
  );
  // Layer cross-check: the same value via the exposed building blocks.
  assert.equal(
    getUserOpHash(goldenOp, ENTRY_POINT, CHAIN_ID),
    toTypedDataHash(
      eip712DomainSeparator(ENTRY_POINT, CHAIN_ID),
      hashPackedUserOperation(goldenOp),
    ),
  );
  // Any field change must change the hash (falsifiable guard).
  assert.notEqual(
    getUserOpHash(
      { ...goldenOp, preVerificationGas: "0x5209" },
      ENTRY_POINT,
      CHAIN_ID,
    ),
    getUserOpHash(goldenOp, ENTRY_POINT, CHAIN_ID),
  );
});

test("EIP-7702 initCode marker detection follows Eip7702Support byte semantics", () => {
  const marker20 = `0x7702${"00".repeat(18)}`;
  assert.equal(isEip7702InitCode(marker20), true);
  assert.equal(isEip7702InitCode(`${marker20}aabb`), true);
  // calldataload zero-pads short payloads, so bare 0x7702 is the marker too.
  assert.equal(isEip7702InitCode("0x7702"), true);
  assert.equal(isEip7702InitCode("0x770202"), false);
  assert.equal(isEip7702InitCode(`0x7703${"00".repeat(18)}`), false);
  assert.equal(isEip7702InitCode("0x"), false);
  assert.equal(isEip7702InitCode("0x77"), false);
  assert.equal(isEip7702InitCode("0xdeadbeef"), false);
});

test("getUserOpHash applies the EIP-7702 initCode hash override and demands the delegate", () => {
  const delegate = "0x6666666666666666666666666666666666666666";
  const opWithTail = { ...goldenOp, initCode: `0x7702${"00".repeat(18)}aabb` };
  // override = keccak256(delegate ‖ initCode[20:])
  // $ cast keccak $(cast concat-hex 0x6666666666666666666666666666666666666666 0xaabb)
  const overrideTail =
    "0xaf7d36a1f850a71c7347bfd44d0c3b4e2f94a5d1913c3367536cfcb6938358f0";
  assert.equal(
    getUserOpHash(opWithTail, ENTRY_POINT, CHAIN_ID, {
      eip7702Delegate: delegate,
    }),
    toTypedDataHash(
      eip712DomainSeparator(ENTRY_POINT, CHAIN_ID),
      hashPackedUserOperation(opWithTail, overrideTail),
    ),
  );
  // Marker-only initCode: override = keccak256(delegate)
  // $ cast keccak 0x6666666666666666666666666666666666666666
  const opMarkerOnly = { ...goldenOp, initCode: `0x7702${"00".repeat(18)}` };
  assert.equal(
    getUserOpHash(opMarkerOnly, ENTRY_POINT, CHAIN_ID, {
      eip7702Delegate: delegate,
    }),
    toTypedDataHash(
      eip712DomainSeparator(ENTRY_POINT, CHAIN_ID),
      hashPackedUserOperation(
        opMarkerOnly,
        "0x8529a8eebfeba4776a5b4d0c50286f6c7e0e862f9c1dfac07fdf1f22e5986aaa",
      ),
    ),
  );
  // Failing loudly beats hashing the wrong bytes: 7702 initCode without the
  // delegate must throw.
  assert.throws(
    () => getUserOpHash(opWithTail, ENTRY_POINT, CHAIN_ID),
    /eip7702Delegate/,
  );
  assert.throws(
    () =>
      getUserOpHash(opWithTail, ENTRY_POINT, CHAIN_ID, {
        eip7702Delegate: "0x1234",
      }),
    /20-byte address/,
  );
});
