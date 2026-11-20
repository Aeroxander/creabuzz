/**
 * The pieces the phone path adds to the shared send code: a sponsor answer is checked before anything is signed, the
 * operation's hash is recorded the moment the bundler accepts it, the bundler and sponsor can be set by URL, the call
 * data can be read back, and the chain reads the app needs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createBundlerTransport } from "./aa.ts";
import {
  createKernel033ChainRpc,
  readEntryPointSequence,
} from "./kernel033.ts";
import {
  callDataCarries,
  decodeExecuteCallData,
  encodeExecuteCallData,
  SenderCallsError,
} from "./sponsoredSender.ts";
import { packAccountGasLimits, packGasFees } from "./userop.ts";
import {
  ENTRY_POINT_V0_7,
  SponsorshipRefusedError,
  UserOpPendingError,
  applySponsorship,
  assertSponsorshipKeepsCall,
  sendSponsoredUserOp,
  zerodevRpcUrl,
  zerodevSponsorUrl,
} from "./zerodev.ts";
import { passkeyCredentialId } from "../account/passkey-identity.ts";

const SENDER = "0x2222222222222222222222222222222222222222";
const PAYMASTER = "0x3333333333333333333333333333333333333333";
const OP_HASH = `0x${"12".repeat(32)}`;
const BUNDLER_URL = "http://bundler.invalid/rpc";
const SPONSOR_URL = "http://sponsor.invalid/rpc";

const CALL_A = {
  to: "0x1111111111111111111111111111111111111111",
  value: "0x0",
  data: "0xaabbccdd",
};
const CALL_B = {
  to: "0x4444444444444444444444444444444444444444",
  value: "0x2386f26fc10000",
  data: "0x",
};

function skeleton(overrides = {}) {
  return {
    sender: SENDER,
    nonce: "0x5",
    initCode: "0x",
    callData: encodeExecuteCallData([CALL_A]),
    accountGasLimits: packAccountGasLimits({
      verificationGasLimit: 0n,
      callGasLimit: 0n,
    }),
    preVerificationGas: "0x0",
    gasFees: packGasFees({
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 5_000_000_000n,
    }),
    paymasterAndData: "0x",
    signature: "0x",
    ...overrides,
  };
}

const GOOD_SPONSORSHIP = {
  preVerificationGas: "0x6000",
  verificationGasLimit: "0x45000",
  callGasLimit: "0x9000",
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: "0x30000",
  paymasterPostOpGasLimit: "0x10000",
  paymasterData: "0xaabb",
};

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected call ${body.method}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, ...next }),
    };
  };
  return { fetchImpl, calls };
}

function sendRequest(extra = {}) {
  return {
    entryPointAddress: ENTRY_POINT_V0_7,
    sender: SENDER,
    nonce: "0x5",
    initCode: "0x",
    callData: encodeExecuteCallData([CALL_A]),
    fees: { maxFeePerGas: "0x12a05f200", maxPriorityFeePerGas: "0x3b9aca00" },
    dummySignature: "0xdd",
    signUserOpHash: () => "0xaabbccdd",
    hashUserOp: () => OP_HASH,
    receipt: { pollIntervalMs: 1, maxPolls: 2 },
    ...extra,
  };
}

// ------------------------------------------------ the sponsor's answer ----

test("a sponsor's answer that keeps the call and sets sane gas is accepted", () => {
  const before = skeleton();
  const after = applySponsorship(before, GOOD_SPONSORSHIP);
  assertSponsorshipKeepsCall(before, after);
  // applySponsorship itself never touches what the person signs for.
  for (const field of ["sender", "nonce", "initCode", "callData"]) {
    assert.equal(after[field], before[field], field);
  }
});

test("a changed sender, nonce, init code or call data is refused, one field at a time", () => {
  const before = skeleton();
  const after = applySponsorship(before, GOOD_SPONSORSHIP);
  const changes = {
    sender: "0x9999999999999999999999999999999999999999",
    nonce: "0x6",
    initCode: "0x1234",
    callData: encodeExecuteCallData([CALL_B]),
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.throws(
      () => assertSponsorshipKeepsCall(before, { ...after, [field]: value }),
      SponsorshipRefusedError,
      field,
    );
  }
});

test("absurd gas limits and a far higher fee ceiling are refused", () => {
  const before = skeleton();
  const wild = applySponsorship(before, {
    ...GOOD_SPONSORSHIP,
    callGasLimit: `0x${(50_000_000n).toString(16)}`,
  });
  assert.throws(
    () => assertSponsorshipKeepsCall(before, wild),
    SponsorshipRefusedError,
  );
  const pricey = applySponsorship(before, {
    ...GOOD_SPONSORSHIP,
    maxFeePerGas: `0x${(500_000_000_000n).toString(16)}`,
  });
  assert.throws(
    () => assertSponsorshipKeepsCall(before, pricey),
    SponsorshipRefusedError,
  );
});

test("sendSponsoredUserOp stops before signing or sending when the sponsor's gas is absurd", async () => {
  const { fetchImpl, calls } = mockFetch([
    { result: { ...GOOD_SPONSORSHIP, callGasLimit: "0xffffffff" } },
  ]);
  let signed = false;
  await assert.rejects(
    sendSponsoredUserOp(
      sendRequest({
        config: {
          bundlerUrl: BUNDLER_URL,
          chainId: 31337,
          fetchImpl,
          maxAttempts: 1,
        },
        signUserOpHash: () => {
          signed = true;
          return "0x";
        },
      }),
    ),
    SponsorshipRefusedError,
  );
  assert.equal(signed, false);
  assert.deepEqual(
    calls.map((c) => c.body.method),
    ["zd_sponsorUserOperation"],
  );
});

test("beforeSign sees the final op and a throw there signs and sends nothing", async () => {
  const { fetchImpl, calls } = mockFetch([{ result: GOOD_SPONSORSHIP }]);
  let seen;
  let signed = false;
  await assert.rejects(
    sendSponsoredUserOp(
      sendRequest({
        config: {
          bundlerUrl: BUNDLER_URL,
          chainId: 31337,
          fetchImpl,
          maxAttempts: 1,
        },
        beforeSign: (op) => {
          seen = op;
          throw new Error("not the calls the person saw");
        },
        signUserOpHash: () => {
          signed = true;
          return "0x";
        },
      }),
    ),
    /not the calls the person saw/,
  );
  assert.equal(seen.callData, encodeExecuteCallData([CALL_A]));
  assert.equal(seen.paymasterAndData.slice(0, 42), PAYMASTER);
  assert.equal(signed, false);
  assert.equal(calls.length, 1);
});

// --------------------------------------------- submitted and pending ----

test("onSubmitted fires after the bundler accepts and before the first receipt look", async () => {
  const { fetchImpl, calls } = mockFetch([
    { result: GOOD_SPONSORSHIP },
    { result: OP_HASH },
    { result: null },
    { result: null },
  ]);
  const order = [];
  await assert.rejects(
    sendSponsoredUserOp(
      sendRequest({
        config: {
          bundlerUrl: BUNDLER_URL,
          chainId: 31337,
          fetchImpl,
          maxAttempts: 1,
        },
        onSubmitted: (submitted) => {
          order.push(["submitted", submitted, calls.length]);
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof UserOpPendingError);
      assert.equal(error.userOpHash, OP_HASH);
      assert.equal(error.sender, SENDER);
      assert.equal(error.nonce, 5n);
      assert.match(error.message, /no receipt for/);
      return true;
    },
  );
  assert.equal(order.length, 1);
  assert.equal(order[0][1].userOpHash, OP_HASH);
  assert.equal(order[0][1].nonce, 5n);
  // Two calls had gone out (sponsor, send) and no receipt look yet.
  assert.equal(order[0][2], 2);
});

// ------------------------------------------------ operator URLs ----

test("the bundler and the sponsor can be set by URL, apart or together", async () => {
  assert.equal(zerodevRpcUrl({ bundlerUrl: BUNDLER_URL }), BUNDLER_URL);
  assert.equal(zerodevSponsorUrl({ bundlerUrl: BUNDLER_URL }), BUNDLER_URL);
  assert.equal(
    zerodevSponsorUrl({ bundlerUrl: BUNDLER_URL, sponsorUrl: SPONSOR_URL }),
    SPONSOR_URL,
  );
  const { fetchImpl, calls } = mockFetch([
    { result: GOOD_SPONSORSHIP },
    { result: OP_HASH },
    {
      result: {
        userOpHash: OP_HASH,
        sender: SENDER,
        nonce: "0x5",
        actualGasCost: "0x1",
        actualGasUsed: "0x1",
        paymaster: PAYMASTER,
        logs: [],
        receipt: { transactionHash: "0x99", blockNumber: "0x1" },
        success: true,
      },
    },
  ]);
  await sendSponsoredUserOp(
    sendRequest({
      config: {
        bundlerUrl: BUNDLER_URL,
        sponsorUrl: SPONSOR_URL,
        chainId: 31337,
        fetchImpl,
        maxAttempts: 1,
      },
    }),
  );
  assert.deepEqual(
    calls.map((c) => [c.body.method, c.url]),
    [
      ["zd_sponsorUserOperation", SPONSOR_URL],
      ["eth_sendUserOperation", BUNDLER_URL],
      ["eth_getUserOperationReceipt", BUNDLER_URL],
    ],
  );
});

test("the bundler transport can ask for an operation by its hash", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      result: {
        userOperation: { sender: SENDER },
        entryPoint: ENTRY_POINT_V0_7,
      },
    },
    { result: null },
  ]);
  const transport = createBundlerTransport({ url: BUNDLER_URL, fetchImpl });
  const known = await transport.getUserOperationByHash(OP_HASH);
  assert.equal(known.entryPoint, ENTRY_POINT_V0_7);
  assert.equal(await transport.getUserOperationByHash(OP_HASH), null);
  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getUserOperationByHash",
    params: [OP_HASH],
  });
});

// ------------------------------------------------ reading call data back ----

test("call data decodes back to the calls that made it (one call, many calls, long data)", () => {
  const long = { to: CALL_A.to, value: "0x7", data: `0x${"ab".repeat(70)}` };
  for (const calls of [[CALL_A], [CALL_A, CALL_B], [long, CALL_B, CALL_A]]) {
    const callData = encodeExecuteCallData(calls);
    assert.deepEqual(decodeExecuteCallData(callData), calls);
    assert.equal(callDataCarries(callData, calls), true);
  }
});

test("call data that is not exactly the shown calls is not accepted", () => {
  const callData = encodeExecuteCallData([CALL_A, CALL_B]);
  assert.equal(callDataCarries(callData, [CALL_A]), false);
  assert.equal(callDataCarries(callData, [CALL_B, CALL_A]), false);
  assert.equal(
    callDataCarries(callData, [CALL_A, { ...CALL_B, value: "0x1" }]),
    false,
  );
  // An extra trailing byte, a wrong function and a cut-short payload are all refused.
  assert.throws(() => decodeExecuteCallData(`${callData}00`), SenderCallsError);
  assert.throws(
    () => decodeExecuteCallData(`0xdeadbeef${callData.slice(10)}`),
    SenderCallsError,
  );
  assert.throws(
    () => decodeExecuteCallData(callData.slice(0, callData.length - 64)),
    SenderCallsError,
  );
  assert.equal(callDataCarries("0x", [CALL_A]), false);
});

// ------------------------------------------------ chain reads ----

test("the chain client reads the newest block, the chain id and logs", async () => {
  const { fetchImpl, calls } = mockFetch([
    { result: "0x10" },
    { result: "0x7a69" },
    {
      result: [
        {
          address: CALL_A.to,
          topics: ["0xaa"],
          data: "0x",
          blockNumber: "0x2",
        },
        { not: "a log" },
      ],
    },
  ]);
  const textFetch = async (url, init) => {
    const response = await fetchImpl(url, init);
    const payload = await response.json();
    return { status: 200, text: async () => JSON.stringify(payload) };
  };
  const rpc = createKernel033ChainRpc({
    url: "http://rpc.invalid",
    fetchImpl: textFetch,
  });
  assert.equal(await rpc.blockNumber(), 16n);
  assert.equal(await rpc.chainId(), 31337);
  const logs = await rpc.getLogs({
    address: CALL_A.to,
    topics: ["0xaa", null],
    from: 1n,
    to: 2n,
  });
  assert.equal(logs.length, 1);
  assert.deepEqual(calls[2].body.params[0], {
    address: CALL_A.to,
    topics: ["0xaa", null],
    fromBlock: "0x1",
    toBlock: "0x2",
  });
});

test("the chain client reads a block's time, by number and for the newest block, and refuses an answer with none", async () => {
  const { fetchImpl, calls } = mockFetch([
    { result: { timestamp: "0x6b49d200" } },
    { result: { timestamp: "0x6b49d201" } },
    { result: null },
  ]);
  const textFetch = async (url, init) => {
    const response = await fetchImpl(url, init);
    const payload = await response.json();
    return { status: 200, text: async () => JSON.stringify(payload) };
  };
  const rpc = createKernel033ChainRpc({
    url: "http://rpc.invalid",
    fetchImpl: textFetch,
    maxAttempts: 1,
  });
  assert.equal(await rpc.blockTime(16n), 0x6b49d200);
  assert.equal(await rpc.blockTime("latest"), 0x6b49d201);
  assert.deepEqual(calls[0].body.params, ["0x10", false]);
  assert.deepEqual(calls[1].body.params, ["latest", false]);
  assert.equal(calls[0].body.method, "eth_getBlockByNumber");
  // A block the node does not know has no time: never zero.
  await assert.rejects(() => rpc.blockTime(99n));
});

test("the account's next sequence number is read from EntryPoint with key 0", async () => {
  let asked;
  const sequence = await readEntryPointSequence(
    {
      ethCall: async (tx) => {
        asked = tx;
        return `0x${7n.toString(16).padStart(64, "0")}`;
      },
    },
    SENDER,
  );
  assert.equal(sequence, 7n);
  assert.equal(asked.to, ENTRY_POINT_V0_7);
  // getNonce(address,uint192): the sender word, then key 0.
  assert.equal(asked.data.slice(10, 74), SENDER.slice(2).padStart(64, "0"));
  assert.equal(asked.data.slice(74), "0".repeat(64));
});

test("the stored passkey credential id is read without the rest of the registration", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  assert.equal(passkeyCredentialId(), null);
  store.set("buzz.passkey.credentialId", "abc");
  assert.equal(passkeyCredentialId(), "abc");
  store.set("buzz.passkey.credentialId", "");
  assert.equal(passkeyCredentialId(), null);
});
