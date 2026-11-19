import assert from "node:assert/strict";
import test from "node:test";

import {
  createSponsoredSender,
  encodeExecuteBatchCallData,
  encodeExecuteSingleCallData,
  PASSKEY_CREDENTIAL_STORAGE_KEY,
  SenderCallsError,
} from "./sponsoredSender.ts";
import {
  buildBidCalls,
  encodeErc20Approve,
  encodePermit2Approve,
  encodeSubmitBid,
  PERMIT2_ADDRESS,
} from "../../launchpad/lib/bid-tx.ts";
import { createInjectedWalletSender } from "../../launchpad/lib/wallet-sender.ts";

// The sponsored sender itself is tested in `packages/creaton-core/src/aa/sponsoredSender.test.mjs`. What stays here is
// the parity of web's injected-wallet sender (launchpad code) with the sponsored sender's call bytes.

// ------------------------------------------------------------- fixtures ----

const CALL_A = {
  to: "0x1111111111111111111111111111111111111111",
  value: "0x0",
  data: "0xaabbccdd",
};
const KERNEL_ADDR = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 11155111;
const CONFIG = { chainId: CHAIN_ID, rpcUrl: "http://rpc.invalid" };
// 65-byte uncompressed secp256r1 key (0x04‖x‖y) exactly as
// `passkey-identity.ts` persists it at `buzz.passkey.r1`: noble `bytesToHex`,
// BARE hex (no 0x prefix).
const R1_HEX = `04${"11".repeat(32)}${"22".repeat(32)}`;
const CREDENTIAL_ID = "test-credential-id";

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Seed the full stored passkey identity (`passkey-identity.ts` schema). */
function seedPasskeyStorage(extra = {}) {
  globalThis.localStorage = fakeStorage({
    [PASSKEY_CREDENTIAL_STORAGE_KEY]: CREDENTIAL_ID,
    "buzz.passkey.salt": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ",
    "buzz.passkey.pubkey": "npub1test",
    "buzz.passkey.mode": "prf",
    "buzz.passkey.r1": R1_HEX,
    ...extra,
  });
}

function fakeChainRpc() {
  return {
    // Catch-all: factory getAddress and EntryPoint getNonce both read words.
    ethCall: async () => `0x${"00".repeat(12)}${KERNEL_ADDR.slice(2)}`,
    getCode: async () => "0x",
    latestBaseFeePerGas: async () => 1_000_000_000n,
  };
}

function fakeZerodev(fetchImpl) {
  return {
    projectId: "test-project",
    apiKey: "test-api-key",
    chainId: CHAIN_ID,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

function fakeUserOpResult(txHash) {
  return {
    txHash,
    blockNumber: "1",
    userOpHash: `0x${"ab".repeat(32)}`,
    sender: KERNEL_ADDR,
    gasUsed: "21000",
    paymaster: `0x${"cd".repeat(20)}`,
    deployed: false,
    success: true,
  };
}

/** Deps that capture the `sendKernel033UserOp`/`getKernel033Sender` seams. */
function capturingDeps(overrides = {}) {
  const requests = [];
  const senderCalls = [];
  let txCounter = 0;
  return {
    requests,
    senderCalls,
    deps: {
      rpc: fakeChainRpc(),
      zerodev: fakeZerodev(),
      getSender: async (params) => {
        senderCalls.push(params);
        return KERNEL_ADDR;
      },
      sendUserOp: async (request) => {
        requests.push(request);
        txCounter += 1;
        return fakeUserOpResult(
          `0x${txCounter.toString(16).padStart(64, "0")}`,
        );
      },
      ...overrides,
    },
  };
}

test("empty call input refuses to send on both adapters", async () => {
  seedPasskeyStorage();
  const { deps } = capturingDeps();
  await assert.rejects(
    createSponsoredSender(CONFIG, deps).sendCalls([]),
    SenderCallsError,
  );
  await assert.rejects(
    createInjectedWalletSender({
      request: async () => {
        throw new Error("unexpected wallet call");
      },
    }).sendCalls([]),
    SenderCallsError,
  );
});

// ------------------------------------------------------------- call parity --

test("the bid composition handed to sendCalls is byte-identical to the injected wallet's ordered calls", async () => {
  // Parity is per-owner: the CCA pulls the budget from the CALLER and pays
  // `owner` (ContinuousClearingAuction.sol `submitBid` → `permit2TransferFrom`),
  // so both senders here bid with the same fixed owner and the sender swap
  // must not change a single calldata byte.
  const auction = "0x6666666666666666666666666666666666666666";
  const plan = {
    maxPriceQ96: 1_000_000_000_000_000_000_000_000n,
    amount: 1_000_000n,
    owner: "0x5555555555555555555555555555555555555555",
    prevTickPriceQ96: 900_000_000_000_000_000_000_000n,
    hookData: "0x",
  };
  const currency = "0x7777777777777777777777777777777777777777";
  const deadline = 1_800_000_000n;
  const composed = buildBidCalls({ auction, plan, currency, deadline });

  // The composer's own bytes for a bidder whose allowance is unknown: the
  // ERC-20 approve to Permit2 (a first-time bidder's payment pull reverts
  // without it), the Permit2 approve, then submitBid.
  assert.deepEqual(composed, [
    {
      to: currency,
      value: "0x0",
      data: encodeErc20Approve(PERMIT2_ADDRESS, plan.amount),
    },
    {
      to: PERMIT2_ADDRESS,
      value: "0x0",
      data: encodePermit2Approve(currency, auction, plan.amount, deadline),
    },
    {
      to: auction,
      value: "0x0",
      data: encodeSubmitBid(plan),
    },
  ]);
  // A returning bidder whose allowance already covers the bid skips the extra leg.
  const returning = buildBidCalls({
    auction,
    plan,
    currency,
    deadline,
    underlyingAllowance: plan.amount,
  });
  assert.equal(returning.length, 2);
  assert.equal(returning[0].to, PERMIT2_ADDRESS);
  // One wei short is not enough.
  assert.equal(
    buildBidCalls({
      auction,
      plan,
      currency,
      deadline,
      underlyingAllowance: plan.amount - 1n,
    }).length,
    3,
  );

  // Injected-wallet path: capture at the eth_sendTransaction wire.
  const walletWire = [];
  const walletSender = createInjectedWalletSender({
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [plan.owner];
      if (method === "eth_sendTransaction") {
        walletWire.push(params[0]);
        return `0x${"11".repeat(32)}`;
      }
      throw new Error(`unexpected wallet method ${method}`);
    },
  });
  await walletSender.sendCalls(composed);
  assert.deepEqual(
    walletWire.map(({ to, value, data }) => ({ to, value, data })),
    composed,
    "the wallet receives the composed calls byte-identically, in order",
  );

  // Sponsored path: capture at the kernel033 UserOp wire. Per-call mode must
  // carry each wallet-delivered call byte-identically in its own UserOp.
  seedPasskeyStorage();
  const perCall = capturingDeps();
  await createSponsoredSender(
    { ...CONFIG, batching: "per-call" },
    perCall.deps,
  ).sendCalls(composed);
  assert.equal(perCall.requests.length, walletWire.length);
  perCall.requests.forEach((request, i) => {
    assert.equal(
      request.callData,
      encodeExecuteSingleCallData(walletWire[i]),
      `UserOp ${i} carries the same call bytes`,
    );
  });

  // Batch mode: one UserOp whose batch executionData is exactly those calls.
  const batched = capturingDeps();
  await createSponsoredSender(CONFIG, batched.deps).sendCalls(composed);
  assert.equal(batched.requests.length, 1);
  assert.equal(
    batched.requests[0].callData,
    encodeExecuteBatchCallData(walletWire),
    "the batched UserOp encodes the very calls the wallet sent",
  );
});

test("the injected wallet sender reports availability and the no-wallet state", async () => {
  assert.equal(createInjectedWalletSender(undefined).isAvailable(), false);
  assert.equal(
    createInjectedWalletSender({ request: async () => [] }).isAvailable(),
    true,
  );
  await assert.rejects(
    createInjectedWalletSender(undefined).sendCalls([CALL_A]),
    /No wallet found in this browser/,
  );
});
