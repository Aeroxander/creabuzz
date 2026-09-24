import assert from "node:assert/strict";
import test from "node:test";

import { buildKernelSelfCallData } from "./aa-kernel.ts";
import { parseR1PublicKey } from "./kernel033.ts";
import {
  createSponsoredSender,
  encodeExecuteBatchCallData,
  encodeExecuteCallData,
  encodeExecuteSingleCallData,
  SenderCallsError,
  SponsoredSenderUnavailableError,
  PASSKEY_CREDENTIAL_STORAGE_KEY,
  sponsoredSenderAvailability,
} from "./sponsoredSender.ts";
import {
  PAYMASTER_DENIED_DASHBOARD_ACTION,
  PaymasterDeniedError,
} from "./zerodev.ts";
import {
  buildBidCalls,
  encodePermit2Approve,
  encodeSubmitBid,
  PERMIT2_ADDRESS,
} from "../../launchpad/lib/bid-tx.ts";
import { createInjectedWalletSender } from "../../launchpad/lib/wallet-sender.ts";

// ------------------------------------------------------------- fixtures ----

const CALL_A = {
  to: "0x1111111111111111111111111111111111111111",
  value: "0x0",
  data: "0xaabbccdd",
};
const CALL_B = {
  to: "0x2222222222222222222222222222222222222222",
  value: "0x2386f26fc10000",
  data: "0x",
};
const KERNEL_ADDR = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 11155111;
const CONFIG = { chainId: CHAIN_ID, rpcUrl: "http://rpc.invalid" };
// 65-byte uncompressed secp256r1 key (0x04‖x‖y) exactly as
// `passkey-identity.ts` persists it at `buzz.passkey.r1`: noble `bytesToHex`,
// BARE hex (no 0x prefix).
const R1_HEX = `04${"11".repeat(32)}${"22".repeat(32)}`;
const CREDENTIAL_ID = "test-credential-id";

// Reference encodings produced with Foundry cast 1.4.3 — do not hand-edit
// hex; re-derive with the commands in the derivations below.
//
// $ cast calldata 'execute(bytes32,bytes)' \
//     0x0000000000000000000000000000000000000000000000000000000000000000 \
//     0x11111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000000aabbccdd
const SINGLE_CALL_A_GOLDEN =
  "0xe9ae5c5300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000003811111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000000aabbccdd0000000000000000";

// $ cast abi-encode 'f((address,uint256,bytes)[])' \
//     "[(0x1111111111111111111111111111111111111111,0x0,0xaabbccdd),\
//(0x2222222222222222222222222222222222222222,0x2386f26fc10000,0x)]"
// $ cast calldata 'execute(bytes32,bytes)' \
//     0x0100000000000000000000000000000000000000000000000000000000000000 <that>
const BATCH_AB_GOLDEN =
  "0xe9ae5c530100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004aabbccdd000000000000000000000000000000000000000000000000000000000000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000";

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

// ------------------------------------------------------ encoding goldens ----

test("single-call execute calldata matches cast + the proven self-call bytes", () => {
  assert.equal(encodeExecuteSingleCallData(CALL_A), SINGLE_CALL_A_GOLDEN);
  // The empty-data single call must be byte-identical to the construction
  // `scripts/zerodev-smoke.mjs` STEP B landed on Sepolia through this stack.
  assert.equal(
    encodeExecuteSingleCallData({
      to: KERNEL_ADDR,
      value: "0x0",
      data: "0x",
    }),
    buildKernelSelfCallData(KERNEL_ADDR),
  );
});

test("batch execute calldata matches cast abi-encode of Execution[]", () => {
  assert.equal(encodeExecuteBatchCallData([CALL_A, CALL_B]), BATCH_AB_GOLDEN);
  // Mode/shape dispatch: one call rides the proven single bytes; several ride
  // CALLTYPE_BATCH over `abi.encode(Execution[])` (v3.3 ExecLib.encodeBatch).
  assert.equal(encodeExecuteCallData([CALL_A]), SINGLE_CALL_A_GOLDEN);
  assert.equal(encodeExecuteCallData([CALL_A, CALL_B]), BATCH_AB_GOLDEN);
});

test("malformed calls are refused with a typed error", () => {
  assert.throws(
    () => encodeExecuteSingleCallData({ to: "0x1234", data: "0x" }),
    SenderCallsError,
  );
  assert.throws(
    () => encodeExecuteSingleCallData({ to: CALL_A.to, data: "0xabc" }),
    SenderCallsError,
  );
  assert.throws(
    () =>
      encodeExecuteSingleCallData({
        to: CALL_A.to,
        data: "0x",
        value: "nope",
      }),
    SenderCallsError,
  );
});

// -------------------------------------------------------- batching shape ----

test("batch mode sends ONE UserOp carrying the whole sequence", async () => {
  seedPasskeyStorage();
  const { requests, deps } = capturingDeps();
  const sender = createSponsoredSender(CONFIG, deps);
  const result = await sender.sendCalls([CALL_A, CALL_B]);

  assert.equal(requests.length, 1, "exactly one UserOp for the sequence");
  assert.equal(requests[0].callData, BATCH_AB_GOLDEN);
  // The passkey seams ride the request untouched.
  assert.equal(requests[0].credentialId, CREDENTIAL_ID);
  assert.equal(requests[0].pubKeyX, parseR1PublicKey(R1_HEX).pubKeyX);
  assert.equal(requests[0].pubKeyY, parseR1PublicKey(R1_HEX).pubKeyY);
  assert.equal(result.status, "confirmed");
  assert.equal(result.userOps.length, 1);
  assert.equal(result.txHash, result.userOps[0].txHash);
});

test("a single call still rides the proven single-execute bytes", async () => {
  seedPasskeyStorage();
  const { requests, deps } = capturingDeps();
  const sender = createSponsoredSender(CONFIG, deps);
  await sender.sendCalls([CALL_A]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].callData, SINGLE_CALL_A_GOLDEN);
});

test("per-call fallback sends one single-execute UserOp per call, in order", async () => {
  seedPasskeyStorage();
  const { requests, deps } = capturingDeps();
  const sender = createSponsoredSender(
    { ...CONFIG, batching: "per-call" },
    deps,
  );
  const result = await sender.sendCalls([CALL_A, CALL_B]);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].callData, SINGLE_CALL_A_GOLDEN);
  assert.equal(
    requests[1].callData,
    encodeExecuteSingleCallData(CALL_B),
    "second UserOp carries the second call byte-identically",
  );
  assert.equal(result.userOps.length, 2);
  // Mirror parity with the injected wallet: the LAST tx hash is the one a
  // `tx` tag binds (here both UserOps are distinct bundle txs).
  assert.equal(result.txHash, result.userOps[result.userOps.length - 1].txHash);
  assert.notEqual(result.userOps[0].txHash, result.userOps[1].txHash);
});

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

// ------------------------------------------------------- error passthrough --

test("a paymaster denial passes through untouched with its dashboard action", async () => {
  for (const batching of ["batch", "per-call"]) {
    seedPasskeyStorage();
    const denial = new PaymasterDeniedError("policy denied: demo project");
    const { deps } = capturingDeps({
      sendUserOp: async () => {
        throw denial;
      },
    });
    await assert.rejects(
      createSponsoredSender({ ...CONFIG, batching }, deps).sendCalls([
        CALL_A,
        CALL_B,
      ]),
      (err) => {
        assert.strictEqual(err, denial, "never re-wrapped (Rule 1)");
        assert.equal(err.serverMessage, "policy denied: demo project");
        assert.equal(err.dashboardAction, PAYMASTER_DENIED_DASHBOARD_ACTION);
        return true;
      },
    );
  }
});

test("a paymaster denial surfaces with dashboardAction (real stack, mocked RPC/fetch)", async () => {
  // Drives the REAL `sendKernel033UserOp` → `sponsorUserOperation` path with
  // a mocked chain RPC and a mocked ZeroDev fetch that denies sponsorship.
  seedPasskeyStorage();
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        error: "policy denied: project sponsorship policy rejects this userOp",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };
  const sender = createSponsoredSender(
    { ...CONFIG, receipt: { pollIntervalMs: 1, maxPolls: 1 } },
    { rpc: fakeChainRpc(), zerodev: fakeZerodev(fetchImpl) },
  );
  await assert.rejects(sender.sendCalls([CALL_A]), (err) => {
    assert.ok(err instanceof PaymasterDeniedError, String(err));
    assert.match(err.serverMessage, /policy denied/);
    assert.equal(err.dashboardAction, PAYMASTER_DENIED_DASHBOARD_ACTION);
    return true;
  });
  assert.ok(
    fetchCalls.some((c) => c.body.method === "zd_sponsorUserOperation"),
    "the sponsorship call was the one mocked and hit",
  );
});

// -------------------------------------------------------------- availability -

test("sponsoredSenderAvailability covers the full input combination space", () => {
  // Every combination of the three inputs (2^3 rows): the result must name
  // exactly what is missing and always carry reason + recovery action when
  // unavailable (Rule 6).
  const table = [
    {
      c: false,
      k: false,
      s: false,
      missing: ["credential", "owner-key", "chain-config"],
    },
    { c: false, k: false, s: true, missing: ["credential", "owner-key"] },
    { c: false, k: true, s: false, missing: ["credential", "chain-config"] },
    { c: false, k: true, s: true, missing: ["credential"] },
    { c: true, k: false, s: false, missing: ["owner-key", "chain-config"] },
    { c: true, k: false, s: true, missing: ["owner-key"] },
    { c: true, k: true, s: false, missing: ["chain-config"] },
    { c: true, k: true, s: true, missing: [] },
  ];
  for (const row of table) {
    const result = sponsoredSenderAvailability({
      credentialId: row.c ? CREDENTIAL_ID : null,
      r1OwnerKey: row.k ? R1_HEX : null,
      chainId: row.s ? CHAIN_ID : 0,
      rpcUrl: row.s ? "http://rpc.invalid" : "",
    });
    assert.deepEqual(result.missing, row.missing, JSON.stringify(row));
    assert.equal(result.available, row.missing.length === 0);
    if (result.available) {
      assert.equal(result.reason, null);
      assert.equal(result.action, null);
    } else {
      assert.ok(result.reason && result.action, JSON.stringify(row));
    }
  }
  // First-blocker messages name their recovery affordance exactly.
  assert.equal(
    sponsoredSenderAvailability({
      credentialId: null,
      r1OwnerKey: R1_HEX,
      chainId: CHAIN_ID,
      rpcUrl: "x",
    }).action,
    "Create a passkey on the identity page (/identity-demo), then retry.",
  );
  assert.equal(
    sponsoredSenderAvailability({
      credentialId: CREDENTIAL_ID,
      r1OwnerKey: null,
      chainId: CHAIN_ID,
      rpcUrl: "x",
    }).action,
    "Re-register the passkey on the identity page (/identity-demo).",
  );
});

test("isAvailable binds storage, the config credential override, and chain config", () => {
  seedPasskeyStorage();
  assert.equal(createSponsoredSender(CONFIG).isAvailable(), true);
  // Credential without the wallet owner key (pre-wallet-owner registration).
  globalThis.localStorage.setItem("buzz.passkey.r1", "");
  assert.equal(createSponsoredSender(CONFIG).isAvailable(), false);
  // No stored identity at all → missing credential AND owner key.
  globalThis.localStorage = fakeStorage();
  assert.equal(createSponsoredSender(CONFIG).isAvailable(), false);
  // Explicit credentialId covers the credential row; the owner key still
  // comes from the stored registration record.
  assert.equal(
    createSponsoredSender({
      ...CONFIG,
      credentialId: CREDENTIAL_ID,
    }).isAvailable(),
    false,
  );
  seedPasskeyStorage();
  assert.equal(
    createSponsoredSender({ ...CONFIG, chainId: 0 }).isAvailable(),
    false,
  );
  assert.equal(
    createSponsoredSender({ ...CONFIG, rpcUrl: "" }).isAvailable(),
    false,
  );
});

test("unavailable send/getAddress throw SponsoredSenderUnavailableError with the action", async () => {
  globalThis.localStorage = fakeStorage();
  const { deps } = capturingDeps();
  const sender = createSponsoredSender(CONFIG, deps);
  await assert.rejects(sender.getAddress(), (err) => {
    assert.ok(err instanceof SponsoredSenderUnavailableError);
    assert.equal(
      err.availability.action,
      "Create a passkey on the identity page (/identity-demo), then retry.",
    );
    return true;
  });
  await assert.rejects(
    sender.sendCalls([CALL_A]),
    SponsoredSenderUnavailableError,
  );
});

test("getAddress derives the Kernel from the stored r1 key and caches it", async () => {
  seedPasskeyStorage();
  const { senderCalls, deps } = capturingDeps();
  const sender = createSponsoredSender(CONFIG, deps);
  assert.equal(await sender.getAddress(), KERNEL_ADDR);
  assert.equal(await sender.getAddress(), KERNEL_ADDR, "cached");
  assert.equal(senderCalls.length, 1, "one bounded derivation call");
  const expected = parseR1PublicKey(R1_HEX);
  assert.equal(senderCalls[0].pubKeyX, expected.pubKeyX);
  assert.equal(senderCalls[0].pubKeyY, expected.pubKeyY);
  assert.equal(typeof senderCalls[0].rpc.ethCall, "function");
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

  // The composer's own bytes: Permit2 approve, then submitBid — unchanged.
  assert.deepEqual(composed, [
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
