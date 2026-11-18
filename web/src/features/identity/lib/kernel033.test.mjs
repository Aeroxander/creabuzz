/**
 * Kernel 0.3.3 account module tests — golden vectors + seam-bound send flow.
 *
 * Provenance (anti-hallucination rule — every vector cites its source):
 *
 * - Initcode goldens: `cast calldata` 1.4.3 of the exact factory/Kernel
 *   signatures (`initialize(bytes21,address,bytes,bytes,bytes[])`,
 *   `createAccount(bytes,bytes32)`, `getAddress(bytes,bytes32)`) with the
 *   smoke's deterministic fixture P-256 JWK coordinates
 *   (`scripts/zerodev-smoke.mjs` FIXTURE_JWK — obviously-fake test key) and
 *   the deployed V0_0_3_PATCHED validator. The exact commands are recorded
 *   inline. These pin the smoke's hand-encoded `initialize` layout (the
 *   in-repo ABI encoder predates bytes21/bytes[]) byte-for-byte.
 * - v0.7 hash goldens: `cast abi-encode` + `cast keccak` of the PLAIN 8-word
 *   `UserOperationLib.encode` (EntryPoint v0.7.0 `UserOperationLib.sol`
 *   `encode`/`hash` + `EntryPoint.sol` lines 363-368) over the same synthetic
 *   probe op as `userop.test.mjs` — deliberately the op whose v0.8
 *   typehash-prefixed struct hash is pinned there, so this file also pins the
 *   live-proven fact that the two hashes DIVERGE (the smoke aborted on the
 *   typehash-prefixed port; only the 8-word form byte-matched the real
 *   Sepolia EntryPoint `getUserOpHash`, 2026-09-24).
 * - Tuple/low-s composition vectors: the V0_0_3_PATCHED 6-field tuple of
 *   `webauthn-auth.ts` (vendored kernel-7579-plugins WebAuthnValidator,
 *   fixed CHALLENGE_LOCATION = 23) over real `node:crypto` P-256 DER
 *   signatures — DER parsing itself is golden-tested in
 *   `webauthn-auth.test.mjs`; this file covers the kernel033 composition
 *   (op-hash-as-challenge → DER → low-s → tuple).
 * - Send-flow shapes: mocked at the production seams (BundlerTransport /
 *   Kernel033ChainRpc / PasskeyAssertionSource) — never test-only helpers
 *   (TESTING.md "Review-Proven Test Standards": falsifiable + seam-binding).
 */
import assert from "node:assert/strict";
import { createPrivateKey, sign as ecdsaSign } from "node:crypto";
import test from "node:test";

import { buildKernelSelfCallData } from "./aa-kernel.ts";
import {
  ENTRY_POINT_V0_7,
  PAYMASTER_DENIED_DASHBOARD_ACTION,
  PaymasterDeniedError,
  applySponsorship,
} from "./zerodev.ts";
import {
  KERNEL_0_3_3_ZERO_SALT,
  KERNEL_FACTORY_0_3_3,
  Kernel033HashMismatchError,
  OFFICIAL_STUB_SIGNATURE,
  WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED,
  assertHashMatchesEntryPoint,
  buildKernel033InitCode,
  encodeKernel033Initialize,
  getKernel033Sender,
  hashPackedUserOperationV07,
  hashUserOpV07,
  parseR1PublicKey,
  sendKernel033UserOp,
  signKernel033UserOp,
  userOpHashCalldataV07,
} from "./kernel033.ts";
import { b64urlEncode } from "./passkey.ts";
import {
  hashPackedUserOperation,
  packAccountGasLimits,
  packGasFees,
  packUints,
} from "./userop.ts";

// ------------------------------------------------------------- fixtures ----

// The smoke's deterministic fixture P-256 JWK (generated once 2026-09-24,
// pinned in `contracts/test/kernel-sign.mjs`) — obviously-fake TEST key.
const FIXTURE_X =
  0x06a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366n;
const FIXTURE_Y =
  0x222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546en;
const FIXTURE_PARAMS = { pubKeyX: FIXTURE_X, pubKeyY: FIXTURE_Y };

// The same synthetic probe op as `userop.test.mjs` (its v0.8 hash is pinned
// there — the v0.7 hashes below prove the two forms DIVERGE).
const ENTRY_POINT_PROBE = "0x1111111111111111111111111111111111111111";
const CHAIN_ID_PROBE = 31337n;
const probeOp = {
  sender: "0x2222222222222222222222222222222222222222",
  nonce: "0x0",
  initCode: "0xdeadbeef",
  callData: "0xc0ffee",
  accountGasLimits: packUints(3n, 5n),
  preVerificationGas: "0x5208",
  gasFees: packUints(1n, 2n),
  paymasterAndData: "0x",
  signature: "0x",
};

const SENDER = "0x2222222222222222222222222222222222222222";
const PAYMASTER = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 11155111;
const CONFIG = {
  projectId: "00000000-0000-4000-8000-00000000beef",
  apiKey: "fake-test-api-key",
  chainId: CHAIN_ID,
};
const FEES = { maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" };

const SPONSORSHIP = {
  preVerificationGas: "0xa4b2",
  verificationGasLimit: "0x1234",
  callGasLimit: "0x2345",
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: "0x1111",
  paymasterPostOpGasLimit: "0x2222",
  paymasterData: "0xaabb",
};

const RECEIPT_OK = {
  userOpHash: "0xunused",
  sender: SENDER,
  nonce: "0x0",
  actualGasCost: "0x174876e800",
  actualGasUsed: "0x186a0",
  paymaster: PAYMASTER,
  receipt: {
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: "0x4e20",
    blockHash: `0x${"cd".repeat(32)}`,
    status: "0x1",
    gasUsed: "0x30d40",
  },
  logs: [],
  success: true,
};

// --------------------------------------------------------- mock helpers -----

function addressWord(address) {
  return `0x${"00".repeat(12)}${address.slice(2)}`;
}

/** Kernel033ChainRpc mock dispatching on the call-data selector. */
function mockRpc({
  events = [],
  sender = SENDER,
  nonceWord = `0x${"00".repeat(32)}`,
  userOpHash,
  code = "0x",
  baseFee = 0n,
}) {
  // `userOpHash` is read at call time so tests can reassign `rpc.userOpHash`
  // after computing the expected sponsored-op hash.
  const rpc = {
    events,
    userOpHash,
    code,
    async ethCall(tx) {
      const selector = tx.data.slice(0, 10);
      events.push(`eth:${selector}`);
      if (selector === "0x48aac392") {
        // getAddress(bytes,bytes32)
        assert.equal(tx.to, KERNEL_FACTORY_0_3_3);
        return addressWord(sender);
      }
      if (selector === "0x35567e1a") {
        // getNonce(address,uint192)
        assert.equal(tx.to, ENTRY_POINT_V0_7);
        return nonceWord;
      }
      if (selector === "0x22cdde4c") {
        // getUserOpHash(...)
        assert.equal(tx.to, ENTRY_POINT_V0_7);
        return rpc.userOpHash(tx);
      }
      throw new Error(`mockRpc: unexpected eth_call selector ${selector}`);
    },
    async getCode(address) {
      events.push("getCode");
      assert.equal(address, sender);
      return rpc.code;
    },
    async latestBaseFeePerGas() {
      events.push("baseFee");
      return baseFee;
    },
  };
  return rpc;
}

/** BundlerTransport mock (production seam) recording the event order. */
function mockTransport({ events = [], sponsorship = SPONSORSHIP, receipt }) {
  const state = { sponsorParams: null, sentOp: null, sentEntryPoint: null };
  return {
    events,
    state,
    url: "mock://zerodev",
    async request(method, params) {
      events.push(`rpc:${method}`);
      if (method !== "zd_sponsorUserOperation") {
        throw new Error(`mockTransport: unexpected request ${method}`);
      }
      if (sponsorship instanceof Error) {
        throw sponsorship;
      }
      state.sponsorParams = params[0];
      return sponsorship;
    },
    async sendUserOperation(userOp, entryPoint) {
      events.push("send");
      state.sentOp = userOp;
      state.sentEntryPoint = entryPoint;
      return hashUserOpV07(userOp, ENTRY_POINT_V0_7, BigInt(CHAIN_ID));
    },
    async estimateUserOperationGas() {
      throw new Error("mockTransport: unexpected gas estimation");
    },
    async getUserOperationReceipt(hash) {
      events.push("receipt");
      assert.equal(
        hash,
        hashUserOpV07(state.sentOp, ENTRY_POINT_V0_7, BigInt(CHAIN_ID)),
      );
      return receipt ?? RECEIPT_OK;
    },
  };
}

/**
 * Real WebAuthn assertion over `challenge` (the smoke's forge-proven
 * construction): canonical clientDataJSON (`"challenge":"` at byte 23),
 * authenticatorData = sha256("localhost") ‖ flags(0x05) ‖ signCount(0), and a
 * REAL `node:crypto` ES256 DER signature over
 * `authenticatorData ‖ sha256(clientDataJSON)`.
 */
const FIXTURE_JWK = {
  kty: "EC",
  x: "BqjPovesWJOn2eU86PyU1j9LVKlpvYN2w5KCEzAus2Y",
  y: "Ii_D2wwf1j9Rb0hDdPZvMCEM57JNbv48Uk62463QVG4",
  crv: "P-256",
  d: "T4FCxtt1hQgHJSwFv78_S0LGYtVvt73h7-RikHaQ_G8",
};
const fixtureKey = createPrivateKey({ key: FIXTURE_JWK, format: "jwk" });

function realAssertionOver(challenge, { createHash, Buffer: B }) {
  const authenticatorData = B.concat([
    createHash("sha256").update("localhost").digest(),
    B.from([0x05]),
    B.alloc(4),
  ]);
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64urlEncode(
    challenge,
  )}","origin":"https://example.com","crossOrigin":false}`;
  const message = B.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const der = ecdsaSign("sha256", message, fixtureKey);
  return {
    credentialId: "test-credential",
    signature: new Uint8Array(der),
    authenticatorData: new Uint8Array(authenticatorData),
    clientDataJSON: new TextEncoder().encode(clientDataJSON),
  };
}

// ------------------------------------------------------- golden vectors -----

test("encodeKernel033Initialize matches cast calldata of initialize (fixture keys)", () => {
  // $ cast calldata "initialize(bytes21,address,bytes,bytes,bytes[])" \
  //     0x017ab16ff354acb328452f1d445b3ddee9a91e9e69 \
  //     0x0000000000000000000000000000000000000000 \
  //     $(cast abi-encode "f((uint256,uint256),bytes32)" \
  //         "(0x06a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366,\
  // 0x222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e)" \
  //         0x0000000000000000000000000000000000000000000000000000000000000000) \
  //     0x "[]"
  assert.equal(
    encodeKernel033Initialize(FIXTURE_PARAMS),
    "0x3c3b752b017ab16ff354acb328452f1d445b3ddee9a91e9e690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000006006a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  );
  // Offsets are computed, not hard-coded: a different validator must move the
  // bytes21 rootValidator word (falsifiable guard).
  assert.notEqual(
    encodeKernel033Initialize({
      ...FIXTURE_PARAMS,
      validationId: "0x1111111111111111111111111111111111111111",
    }),
    encodeKernel033Initialize(FIXTURE_PARAMS),
  );
  assert.throws(
    () => encodeKernel033Initialize({ ...FIXTURE_PARAMS, validationId: "0x1" }),
    /20-byte address/,
  );
});

test("buildKernel033InitCode matches factory ‖ cast calldata of createAccount", () => {
  // $ cast calldata "createAccount(bytes,bytes32)" <initData from above> \
  //     0x0000000000000000000000000000000000000000000000000000000000000000
  const initCode = buildKernel033InitCode(FIXTURE_PARAMS);
  assert.equal(
    initCode,
    `${KERNEL_FACTORY_0_3_3}ea6d13ac0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001643c3b752b017ab16ff354acb328452f1d445b3ddee9a91e9e690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000006006a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`,
  );
  // Salt moves the CREATE2 args (falsifiable guard).
  assert.notEqual(
    buildKernel033InitCode({
      ...FIXTURE_PARAMS,
      salt: `0x${"11".repeat(32)}`,
    }),
    initCode,
  );
  assert.equal(KERNEL_0_3_3_ZERO_SALT, `0x${"00".repeat(32)}`);
});

test("getKernel033Sender calls factory getAddress with the cast golden and decodes", async () => {
  // $ cast calldata "getAddress(bytes,bytes32)" <initData from above> \
  //     0x0000000000000000000000000000000000000000000000000000000000000000
  const calls = [];
  const sender = await getKernel033Sender({
    ...FIXTURE_PARAMS,
    rpc: {
      ethCall: async (tx) => {
        calls.push(tx);
        return addressWord(SENDER);
      },
    },
  });
  assert.equal(sender, SENDER);
  assert.deepEqual(calls, [
    {
      to: KERNEL_FACTORY_0_3_3,
      data: "0x48aac3920000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001643c3b752b017ab16ff354acb328452f1d445b3ddee9a91e9e690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000006006a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    },
  ]);
});

test("hashPackedUserOperationV07 matches the cast-derived 8-word struct hash — and DIVERGES from the v0.8 typehash-prefixed form", () => {
  // Derivation (cast 1.4.3) — keccak of the PLAIN 8-word abi.encode of
  // v0.7.0 UserOperationLib.encode (NO PACKED_USEROP_TYPEHASH prefix):
  // $ cast abi-encode "f(address,uint256,bytes32,bytes32,bytes32,uint256,bytes32,bytes32)" \
  //     0x2222222222222222222222222222222222222222 0x0 \
  //     0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1 \
  //     0x7924f890e12acdf516d6278e342cd34550e3bafe0a3dec1b9c2c3e991733711a \
  //     0x0000000000000000000000000000000300000000000000000000000000000005 21000 \
  //     0x0000000000000000000000000000000100000000000000000000000000000002 \
  //     0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470 \
  //   | cast keccak  -> 0x19031f41d4aeacde8840c3a9a7238352d4afd29c3bb3bd28ab470f6101118e93
  assert.equal(
    hashPackedUserOperationV07(probeOp),
    "0x19031f41d4aeacde8840c3a9a7238352d4afd29c3bb3bd28ab470f6101118e93",
  );
  // The live-proven distinction (smoke 2026-09-24): the v0.8 EIP-712 struct
  // hash (typehash-prefixed, pinned in userop.test.mjs as 0x08eefb1b…) is NOT
  // the v0.7 struct hash — using it mismatched the real EntryPoint.
  const v08 = hashPackedUserOperation(probeOp);
  assert.notEqual(v08, hashPackedUserOperationV07(probeOp));
  assert.equal(
    v08,
    "0x08eefb1bb6cf58afe201fbfd716022e1734b83e1a74f9ae95e40b6a9be354e28",
  );
  // Falsifiable: any field change must change the hash.
  assert.notEqual(
    hashPackedUserOperationV07({ ...probeOp, preVerificationGas: "0x5209" }),
    hashPackedUserOperationV07(probeOp),
  );
});

test("hashUserOpV07 matches the cast-derived final triple-hash", () => {
  // structHash = 0x19031f41d4aeacde8840c3a9a7238352d4afd29c3bb3bd28ab470f6101118e93
  // $ cast abi-encode "f(bytes32,address,bytes32)" <structHash> \
  //     0x1111111111111111111111111111111111111111 <31337 as a full word> \
  //   | cast keccak  -> 0xb63630cc0256fdcbd5925c215919a58442cd0cfb0c2f34c067d6740614cb846b
  assert.equal(
    hashUserOpV07(probeOp, ENTRY_POINT_PROBE, CHAIN_ID_PROBE),
    "0xb63630cc0256fdcbd5925c215919a58442cd0cfb0c2f34c067d6740614cb846b",
  );
  // Falsifiable: entryPoint and chainId are inside the signed hash.
  assert.notEqual(
    hashUserOpV07(probeOp, ENTRY_POINT_V0_7, CHAIN_ID_PROBE),
    hashUserOpV07(probeOp, ENTRY_POINT_PROBE, CHAIN_ID_PROBE),
  );
  assert.notEqual(
    hashUserOpV07(probeOp, ENTRY_POINT_PROBE, 1n),
    hashUserOpV07(probeOp, ENTRY_POINT_PROBE, CHAIN_ID_PROBE),
  );
});

// ------------------------------------------------------ the hash guard ------

test("assertHashMatchesEntryPoint probes the live EntryPoint with the cast golden calldata and passes on byte-equality", async () => {
  // $ cast calldata "getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))" \
  //     "(0x2222222222222222222222222222222222222222,0x0,0xdeadbeef,0xc0ffee,\
  // 0x0000000000000000000000000000000300000000000000000000000000000005,21000,\
  // 0x0000000000000000000000000000000100000000000000000000000000000002,0x,0x)"
  const calls = [];
  const hash = await assertHashMatchesEntryPoint(probeOp, {
    entryPoint: ENTRY_POINT_PROBE,
    chainId: CHAIN_ID_PROBE,
    rpc: {
      ethCall: async (tx) => {
        calls.push(tx);
        return "0xb63630cc0256fdcbd5925c215919a58442cd0cfb0c2f34c067d6740614cb846b";
      },
    },
  });
  assert.equal(
    hash,
    "0xb63630cc0256fdcbd5925c215919a58442cd0cfb0c2f34c067d6740614cb846b",
  );
  assert.deepEqual(calls, [
    {
      to: ENTRY_POINT_PROBE,
      data: "0x22cdde4c0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000003000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000005208000000000000000000000000000000010000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000004deadbeef000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c0ffee000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    },
  ]);
});

test("assertHashMatchesEntryPoint refuses on mismatch and reports both hashes", async () => {
  const wrong = `0x${"11".repeat(32)}`;
  await assert.rejects(
    assertHashMatchesEntryPoint(probeOp, {
      entryPoint: ENTRY_POINT_PROBE,
      chainId: CHAIN_ID_PROBE,
      rpc: { ethCall: async () => wrong },
    }),
    (error) => {
      assert.ok(error instanceof Kernel033HashMismatchError);
      assert.equal(
        error.localHash,
        "0xb63630cc0256fdcbd5925c215919a58442cd0cfb0c2f34c067d6740614cb846b",
      );
      assert.equal(error.onChainHash, wrong);
      assert.match(error.message, /refusing to sign the wrong bytes/);
      return true;
    },
  );
});

test("userOpHashCalldataV07 throws on non-hex op fields rather than encoding garbage", () => {
  assert.throws(
    () => userOpHashCalldataV07({ ...probeOp, callData: "nope" }),
    /0x-prefixed hex/,
  );
});

// ------------------------------------------------- passkey composition ------

function encodeDerInt(value) {
  const hex = value.toString(16).padStart(64, "0");
  let bytes = Buffer.from(hex, "hex");
  while (bytes.length > 1 && bytes[0] === 0x00 && bytes[1] < 0x80) {
    bytes = bytes.slice(1);
  }
  if (bytes[0] >= 0x80) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function encodeDer(r, s) {
  const body = Buffer.concat([encodeDerInt(r), encodeDerInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

const P256_N = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

test("signKernel033UserOp: op-hash bytes become the WebAuthn challenge and the assertion wraps as the V0_0_3_PATCHED tuple (low-s)", async () => {
  const { createHash } = await import("node:crypto");
  const opHash = `0x${"42".repeat(32)}`;
  const record = { options: null, assertion: null };
  const signature = await signKernel033UserOp({
    credentialId: "cred-1",
    opHash,
    rpId: "example.com",
    getAssertion: async (options) => {
      record.options = options;
      // A REAL ES256 assertion over the received challenge (ECDSA k is
      // non-deterministic — keep the exact bytes to compare the wrap against).
      record.assertion = realAssertionOver(options.challenge, {
        createHash,
        Buffer,
      });
      return record.assertion;
    },
  });
  // The ceremony receives the OP HASH BYTES as the challenge, no PRF salt,
  // and the caller's rpId (production seam contract).
  assert.deepEqual(
    Array.from(record.options.challenge),
    Array.from(Buffer.from("42".repeat(32), "hex")),
  );
  assert.equal(record.options.credentialId, "cred-1");
  assert.equal(record.options.rpId, "example.com");
  assert.equal("prfSalt" in record.options, false);
  // The wrapped tuple is the 6-field V0_0_3_PATCHED signature
  // (bytes,string,uint256,uint256,uint256,bool) — golden-encoded in
  // webauthn-auth.test.mjs via cast; here the composition pins challenge
  // location 23 and the real DER → low-s conversion.
  const { wrapPasskeyAssertionForZeroDevValidator } = await import(
    "./webauthn-auth.ts"
  );
  const wrapped = wrapPasskeyAssertionForZeroDevValidator(record.assertion, {
    challengeHex: opHash,
    usePrecompiled: false,
  });
  assert.equal(wrapped.encoded, signature);
  assert.equal(wrapped.responseTypeLocation, 1n); // `"type"` at byte 1
  assert.ok(BigInt(wrapped.s) <= P256_N >> 1n); // low-s normalized

  // High-s input DER is normalized to (r, n − s) — the on-chain P256 check
  // rejects s > n/2 (vendored P256.sol anti-malleability).
  const r = 0x1111111111111111111111111111111111111111111111111111111111111111n;
  const sLow =
    0x2222222222222222222222222222222222222222222222222222222222222222n;
  const sHigh = P256_N - sLow; // > n/2 on purpose
  const highAssertion = {
    credentialId: "cred-1",
    signature: new Uint8Array(encodeDer(r, sHigh)),
    authenticatorData: record.assertion.authenticatorData,
    clientDataJSON: record.assertion.clientDataJSON,
  };
  const normalized = await signKernel033UserOp({
    credentialId: "cred-1",
    opHash,
    getAssertion: async () => highAssertion,
  });
  const expected = wrapPasskeyAssertionForZeroDevValidator(highAssertion, {
    challengeHex: opHash,
    usePrecompiled: false,
  });
  assert.equal(normalized, expected.encoded);
  assert.equal(BigInt(expected.r), r);
  assert.equal(BigInt(expected.s), sLow);
});

test("signKernel033UserOp: an assertion over a DIFFERENT hash is refused before wrapping", async () => {
  const { createHash } = await import("node:crypto");
  const otherChallenge = Buffer.from("43".repeat(32), "hex");
  await assert.rejects(
    signKernel033UserOp({
      credentialId: "cred-1",
      opHash: `0x${"42".repeat(32)}`,
      getAssertion: async () =>
        realAssertionOver(otherChallenge, { createHash, Buffer }),
    }),
    /assertion signed a different hash/,
  );
  // Bad op hashes fail before any ceremony.
  await assert.rejects(
    signKernel033UserOp({
      credentialId: "cred-1",
      opHash: "0x1234",
      getAssertion: async () => {
        throw new Error("ceremony must not run");
      },
    }),
    /32-byte bytes32/,
  );
});

// -------------------------------------------------------- send flow ---------

function expectedSponsored({ sender, initCode, callData, fees }) {
  return applySponsorship(
    {
      sender,
      nonce: "0x0",
      initCode,
      callData,
      accountGasLimits: packAccountGasLimits({
        verificationGasLimit: 0n,
        callGasLimit: 0n,
      }),
      preVerificationGas: "0x0",
      gasFees: packGasFees({
        maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
        maxFeePerGas: BigInt(fees.maxFeePerGas),
      }),
      paymasterAndData: "0x",
      signature: OFFICIAL_STUB_SIGNATURE,
    },
    SPONSORSHIP,
  );
}

function ceremony(events) {
  return async (options) => {
    events.push("assertion");
    return realAssertionOver(options.challenge, {
      createHash: (await import("node:crypto")).createHash,
      Buffer,
    });
  };
}

test("sendKernel033UserOp: sponsor-first → hash-guard → real sign → submit → receipt (event order + wire shapes)", async () => {
  const events = [];
  const rpc = mockRpc({ events, userOpHash: () => null });
  const transport = mockTransport({ events });
  // The guard's on-chain probe returns exactly the local v0.7 hash of the
  // sponsored op (computed from the known deterministic inputs).
  const expected = expectedSponsored({
    sender: SENDER,
    initCode: `${KERNEL_FACTORY_0_3_3}ea6d13ac0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001643c3b752b017ab16ff354acb328452f1d445b3ddee9a91e9e690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000006006a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`,
    callData: buildKernelSelfCallData(SENDER),
    fees: FEES,
  });
  const expectedHash = hashUserOpV07(
    expected,
    ENTRY_POINT_V0_7,
    BigInt(CHAIN_ID),
  );
  rpc.userOpHash = () => expectedHash;

  const phases = [];
  const result = await sendKernel033UserOp({
    credentialId: "cred-1",
    pubKeyX: FIXTURE_X,
    pubKeyY: FIXTURE_Y,
    config: CONFIG,
    rpc,
    fees: FEES,
    transport,
    getAssertion: ceremony(events),
    onPhase: (phase) => phases.push(phase),
  });

  // Event order pins the safety-critical sequencing: nothing is signed
  // before sponsorship AND the hash guard.
  assert.deepEqual(events, [
    "eth:0x48aac392", // factory.getAddress
    "getCode",
    "eth:0x35567e1a", // EntryPoint.getNonce
    "rpc:zd_sponsorUserOperation",
    "eth:0x22cdde4c", // hash guard
    "assertion", // Touch ID only AFTER the guard
    "send",
    "receipt",
  ]);
  assert.deepEqual(phases, [
    "preparing",
    "sponsoring",
    "signing",
    "submitting",
    "confirming",
  ]);

  // Sponsor wire (zerodev.ts ledger item 3/4): unpacked v0.7 keys, no packed
  // keys, PartialBy gas fields omitted (server-side estimation), stub
  // signature for the simulation.
  const sponsorOp = transport.state.sponsorParams.userOp;
  assert.equal(transport.state.sponsorParams.chainId, CHAIN_ID);
  assert.equal(
    transport.state.sponsorParams.entryPointAddress,
    ENTRY_POINT_V0_7,
  );
  assert.equal(transport.state.sponsorParams.manualGasEstimation, false);
  assert.equal(transport.state.sponsorParams.shouldConsume, true);
  assert.equal(sponsorOp.factory, KERNEL_FACTORY_0_3_3);
  assert.equal(
    sponsorOp.factoryData,
    `0xea6d13ac0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001643c3b752b017ab16ff354acb328452f1d445b3ddee9a91e9e690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000006006a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`,
  );
  assert.equal("initCode" in sponsorOp, false);
  assert.equal("accountGasLimits" in sponsorOp, false);
  assert.equal("gasFees" in sponsorOp, false);
  assert.equal("paymasterAndData" in sponsorOp, false);
  assert.equal("callGasLimit" in sponsorOp, false);
  assert.equal("verificationGasLimit" in sponsorOp, false);
  assert.equal("preVerificationGas" in sponsorOp, false);
  assert.equal(sponsorOp.signature, OFFICIAL_STUB_SIGNATURE);

  // The submitted op: initCode = factory ‖ createAccount golden, signature =
  // the REAL wrapped passkey tuple (≠ the stub).
  const sent = transport.state.sentOp;
  assert.equal(
    sent.initCode,
    `${KERNEL_FACTORY_0_3_3}ea6d13ac0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001643c3b752b017ab16ff354acb328452f1d445b3ddee9a91e9e690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000006006a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`,
  );
  assert.equal(transport.state.sentEntryPoint, ENTRY_POINT_V0_7);
  assert.notEqual(sent.signature, OFFICIAL_STUB_SIGNATURE);
  assert.ok(sent.signature.startsWith("0x"));

  // Typed result mapping (nested tx receipt — aa.ts UserOperationReceipt).
  assert.deepEqual(
    {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      userOpHash: result.userOpHash,
      sender: result.sender,
      gasUsed: result.gasUsed,
      paymaster: result.paymaster,
      deployed: result.deployed,
      success: result.success,
    },
    {
      txHash: RECEIPT_OK.receipt.transactionHash,
      blockNumber: "0x4e20",
      userOpHash: expectedHash,
      sender: SENDER,
      gasUsed: "0x186a0",
      paymaster: PAYMASTER,
      deployed: true,
      success: true,
    },
  );
});

test("sendKernel033UserOp: idempotent sender — deployed account gets NO initCode", async () => {
  const events = [];
  const code = "0x6080604052";
  const rpc = mockRpc({ events, code, userOpHash: () => null });
  const transport = mockTransport({ events });
  const expected = expectedSponsored({
    sender: SENDER,
    initCode: "0x",
    callData: buildKernelSelfCallData(SENDER),
    fees: FEES,
  });
  rpc.userOpHash = () =>
    hashUserOpV07(expected, ENTRY_POINT_V0_7, BigInt(CHAIN_ID));

  const result = await sendKernel033UserOp({
    credentialId: "cred-1",
    pubKeyX: FIXTURE_X,
    pubKeyY: FIXTURE_Y,
    config: CONFIG,
    rpc,
    fees: FEES,
    transport,
    getAssertion: ceremony(events),
  });
  assert.equal(transport.state.sentOp.initCode, "0x");
  assert.equal("factory" in transport.state.sponsorParams.userOp, false);
  assert.equal("factoryData" in transport.state.sponsorParams.userOp, false);
  assert.equal(result.deployed, false);
});

test("sendKernel033UserOp: fees default to latest baseFee × 3 + 2 gwei (the smoke's formula)", async () => {
  const events = [];
  const baseFee = 10n * 10n ** 9n;
  const derivedFees = {
    maxFeePerGas: `0x${(baseFee * 3n + 2n * 10n ** 9n).toString(16)}`,
    maxPriorityFeePerGas: `0x${(10n ** 9n).toString(16)}`,
  };
  const rpc = mockRpc({
    events,
    baseFee,
    code: "0x6080604052",
    userOpHash: () => null,
  });
  const transport = mockTransport({ events });
  const expected = expectedSponsored({
    sender: SENDER,
    initCode: "0x",
    callData: buildKernelSelfCallData(SENDER),
    fees: derivedFees,
  });
  rpc.userOpHash = () =>
    hashUserOpV07(expected, ENTRY_POINT_V0_7, BigInt(CHAIN_ID));

  await sendKernel033UserOp({
    credentialId: "cred-1",
    pubKeyX: FIXTURE_X,
    pubKeyY: FIXTURE_Y,
    config: CONFIG,
    rpc,
    transport,
    getAssertion: ceremony(events),
  });
  assert.deepEqual(events.includes("baseFee"), true);
  assert.equal(
    transport.state.sponsorParams.userOp.maxFeePerGas,
    derivedFees.maxFeePerGas,
  );
  assert.equal(
    transport.state.sponsorParams.userOp.maxPriorityFeePerGas,
    derivedFees.maxPriorityFeePerGas,
  );
});

test("sendKernel033UserOp: hash-guard refusal — NOTHING is signed or sent on mismatch", async () => {
  const events = [];
  const wrong = `0x${"11".repeat(32)}`;
  const rpc = mockRpc({ events, userOpHash: () => wrong });
  const transport = mockTransport({ events });
  await assert.rejects(
    sendKernel033UserOp({
      credentialId: "cred-1",
      pubKeyX: FIXTURE_X,
      pubKeyY: FIXTURE_Y,
      config: CONFIG,
      rpc,
      fees: FEES,
      transport,
      getAssertion: ceremony(events),
    }),
    (error) => {
      assert.ok(error instanceof Kernel033HashMismatchError);
      assert.equal(error.onChainHash, wrong);
      return true;
    },
  );
  // The guard earned its keep: no Touch ID, no submission.
  assert.deepEqual(events, [
    "eth:0x48aac392",
    "getCode",
    "eth:0x35567e1a",
    "rpc:zd_sponsorUserOperation",
    "eth:0x22cdde4c",
  ]);
});

test("sendKernel033UserOp: PaymasterDeniedError passes through typed with its dashboard action", async () => {
  const events = [];
  const denial = new Error(
    'bundler: zd_sponsorUserOperation RPC error {"error":"UserOperation reverted during simulation with reason: policy denied for this sender"}',
  );
  const rpc = mockRpc({ events, userOpHash: () => null });
  const transport = mockTransport({ events, sponsorship: denial });
  await assert.rejects(
    sendKernel033UserOp({
      credentialId: "cred-1",
      pubKeyX: FIXTURE_X,
      pubKeyY: FIXTURE_Y,
      config: CONFIG,
      rpc,
      fees: FEES,
      transport,
      getAssertion: ceremony(events),
    }),
    (error) => {
      assert.ok(error instanceof PaymasterDeniedError);
      assert.match(error.serverMessage, /policy denied for this sender/);
      assert.equal(error.dashboardAction, PAYMASTER_DENIED_DASHBOARD_ACTION);
      return true;
    },
  );
  // Sponsor-first means the denial happens BEFORE any ceremony (Rule 1: the
  // raw server message survives on the typed error).
  assert.equal(events.includes("assertion"), false);
  assert.equal(events.includes("send"), false);
});

// ------------------------------------------------------------ small units ---

test("parseR1PublicKey splits the 65-byte uncompressed key into coordinates", () => {
  const hex = `0x04${FIXTURE_X.toString(16).padStart(64, "0")}${FIXTURE_Y.toString(
    16,
  ).padStart(64, "0")}`;
  assert.deepEqual(parseR1PublicKey(hex), {
    pubKeyX: FIXTURE_X,
    pubKeyY: FIXTURE_Y,
  });
  // The PERSISTED form (`passkey-identity.ts` → noble `bytesToHex` at
  // `buzz.passkey.r1`) is BARE hex without the 0x prefix — the e2e caught
  // this seam (the browser card passes localStorage verbatim).
  assert.deepEqual(parseR1PublicKey(hex.slice(2)), {
    pubKeyX: FIXTURE_X,
    pubKeyY: FIXTURE_Y,
  });
  assert.throws(() => parseR1PublicKey("0x04aabb"), /65-byte uncompressed/);
});

test("default account params are the deployed stack constants", () => {
  assert.equal(
    WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED,
    "0x7ab16ff354acb328452f1d445b3ddee9a91e9e69",
  );
  assert.equal(
    KERNEL_FACTORY_0_3_3,
    "0x2577507b78c2008ff367261cb6285d44ba5ef2e9",
  );
  // The stub is the 6-field tuple (static + dynamic head → 5 head words).
  assert.ok(OFFICIAL_STUB_SIGNATURE.length > 2 + 5 * 64 * 2);
  assert.ok(OFFICIAL_STUB_SIGNATURE.startsWith("0x"));
});
