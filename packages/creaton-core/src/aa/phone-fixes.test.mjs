// Defects a review of the phone path found in the core, each pinned on the code the app runs: the operator's sponsor
// address must be used by the app's own send (`sendKernel033UserOp`), an operation the bundler may hold must be recorded
// before the send, a receipt for another operation is no answer, and a sponsor's paymaster fields are checked.
import assert from "node:assert/strict";
import test from "node:test";
import { BundlerRpcError, createBundlerTransport } from "./aa.ts";
import { getKernel033Sender, sendKernel033UserOp } from "./kernel033.ts";
import { encodeExecuteCallData } from "./sponsoredSender.ts";
import { ENTRY_POINT_V0_7, sendSponsoredUserOp } from "./zerodev.ts";

const SENDER = "0x2222222222222222222222222222222222222222";
const PM = "0x3333333333333333333333333333333333333333";
const OP_HASH = `0x${"12".repeat(32)}`;
const CALL = {
  to: "0x1111111111111111111111111111111111111111",
  value: "0x0",
  data: "0xaabbccdd",
};
const json = (id, result, error) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const sponsorAnswer = {
  preVerificationGas: "0x5000",
  verificationGasLimit: "0x50000",
  callGasLimit: "0x50000",
  paymaster: PM,
  paymasterVerificationGasLimit: "0x10000",
  paymasterPostOpGasLimit: "0x10000",
  paymasterData: "0x",
};
const base = (fetchImpl, extra = {}) => ({
  config: {
    chainId: 31337,
    bundlerUrl: "http://b.invalid",
    fetchImpl,
    maxAttempts: 1,
  },
  entryPointAddress: ENTRY_POINT_V0_7,
  sender: SENDER,
  nonce: "0x5",
  initCode: "0x",
  callData: encodeExecuteCallData([CALL]),
  fees: { maxFeePerGas: "0x10", maxPriorityFeePerGas: "0x1" },
  dummySignature: "0x00",
  hashUserOp: () => OP_HASH,
  signUserOpHash: () => "0xdead",
  ...extra,
});

test("the app's send asks the sponsor URL for the fee, not the bundler", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push([body.method, String(url)]);
    return json(body.id, null, { code: -32000, message: "stop here" });
  };
  const word = `0x${"00".repeat(12)}${"22".repeat(20)}`;
  const rpc = {
    ethCall: async ({ data }) =>
      data.startsWith("0x35567e1a") ? `0x${"00".repeat(32)}` : word,
    getCode: async () => "0x",
    latestBaseFeePerGas: async () => 1n,
  };
  await sendKernel033UserOp({
    credentialId: "c",
    pubKeyX: 1n,
    pubKeyY: 2n,
    config: {
      bundlerUrl: "http://bundler.invalid/rpc",
      sponsorUrl: "http://sponsor.invalid/rpc",
      chainId: 31337,
      fetchImpl,
      maxAttempts: 1,
    },
    rpc,
    getAssertion: async () => {
      throw new Error("no");
    },
  }).catch(() => {});
  const asked = seen.filter((s) => s[0] === "zd_sponsorUserOperation");
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], "http://sponsor.invalid/rpc");
});

test("with a transport passed in and a sponsor URL set, the sponsor URL still gets the sponsor request", async () => {
  const hits = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    hits.push([body.method, String(url)]);
    return json(body.id, null, { code: -1, message: "stop" });
  };
  const transport = createBundlerTransport({
    url: "http://own.invalid",
    fetchImpl,
    maxAttempts: 1,
  });
  await sendSponsoredUserOp(
    base(fetchImpl, {
      transport,
      config: {
        chainId: 31337,
        sponsorUrl: "http://sponsor.invalid",
        fetchImpl,
        maxAttempts: 1,
      },
    }),
  ).catch(() => {});
  assert.deepEqual(hits[0], [
    "zd_sponsorUserOperation",
    "http://sponsor.invalid",
  ]);
});

test("onSigned fires after signing and before the send, with what a later look-up needs", async () => {
  const order = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "zd_sponsorUserOperation")
      return json(body.id, sponsorAnswer);
    order.push(body.method);
    return json(body.id, null, { code: -32500, message: "AA23 reverted" });
  };
  let signed;
  await assert.rejects(
    sendSponsoredUserOp(
      base(fetchImpl, {
        onSigned: (s) => {
          order.push("signed");
          signed = s;
        },
      }),
    ),
  );
  assert.deepEqual(order, ["signed", "eth_sendUserOperation"]);
  assert.deepEqual(signed, { userOpHash: OP_HASH, sender: SENDER, nonce: 5n });
});

test("a bundler that took the operation but whose answer was lost: the record exists and the error says it may have been taken", async () => {
  let attempts = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "zd_sponsorUserOperation")
      return json(body.id, sponsorAnswer);
    attempts += 1;
    if (attempts === 1)
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      );
    return json(body.id, null, {
      code: -32602,
      message: "userOperation with this hash is already known",
    });
  };
  let signed = false;
  let submitted = false;
  let error;
  try {
    await sendSponsoredUserOp(
      base(fetchImpl, {
        config: {
          chainId: 31337,
          bundlerUrl: "http://b.invalid",
          fetchImpl,
          timeoutMs: 30,
          maxAttempts: 3,
          backoffMs: 1,
        },
        onSigned: () => {
          signed = true;
        },
        onSubmitted: () => {
          submitted = true;
        },
      }),
    );
  } catch (e) {
    error = e;
  }
  assert.equal(attempts, 2);
  assert.ok(signed, "recorded before the send");
  assert.equal(submitted, false);
  assert.ok(error instanceof BundlerRpcError);
  assert.equal(
    error.maybeDelivered,
    true,
    "a later refusal says nothing about the first try",
  );
});

test("a bundler's plain refusal on the first and only try is not 'maybe delivered'", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "zd_sponsorUserOperation")
      return json(body.id, sponsorAnswer);
    return json(body.id, null, {
      code: -32500,
      message: "AA24 signature error",
    });
  };
  const error = await sendSponsoredUserOp(base(fetchImpl)).catch((e) => e);
  assert.ok(error instanceof BundlerRpcError);
  assert.equal(error.maybeDelivered, false);
});

test("a receipt for another operation is never taken for this one", async () => {
  const forged = {
    userOpHash: `0x${"ff".repeat(32)}`,
    success: true,
    actualGasUsed: "0x1",
    receipt: {
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: "0x1",
      logs: [],
    },
    logs: [],
  };
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "zd_sponsorUserOperation")
      return json(body.id, sponsorAnswer);
    if (body.method === "eth_sendUserOperation") return json(body.id, OP_HASH);
    if (body.method === "eth_getUserOperationReceipt")
      return json(body.id, forged);
    return json(body.id, null);
  };
  await assert.rejects(
    sendSponsoredUserOp(
      base(fetchImpl, { receipt: { pollIntervalMs: 1, maxPolls: 2 } }),
    ),
    /receipt for 0xffff/,
  );
});

test("a sponsor naming no usable paymaster, or absurd paymaster gas, gets no signature", async () => {
  const cases = [
    { paymaster: "0x0000000000000000000000000000000000000000" },
    { paymasterPostOpGasLimit: `0x${"f".repeat(32)}` },
    { paymasterVerificationGasLimit: `0x${"f".repeat(32)}` },
  ];
  for (const change of cases) {
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "zd_sponsorUserOperation")
        return json(body.id, { ...sponsorAnswer, ...change });
      return json(body.id, null, { code: -1, message: "stop" });
    };
    let signed = false;
    const error = await sendSponsoredUserOp(
      base(fetchImpl, {
        signUserOpHash: () => {
          signed = true;
          return "0xdead";
        },
      }),
    ).catch((e) => e);
    assert.equal(signed, false, JSON.stringify(change));
    assert.equal(error.name, "SponsorshipRefusedError", JSON.stringify(change));
  }
});

test("a node that answers the zero address for the account is refused, not shown", async () => {
  const rpc = { ethCall: async () => `0x${"00".repeat(32)}` };
  await assert.rejects(
    getKernel033Sender({ pubKeyX: 1n, pubKeyY: 2n, rpc }),
    /zero address/,
  );
});
