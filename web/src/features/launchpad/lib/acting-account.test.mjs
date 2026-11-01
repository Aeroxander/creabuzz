import assert from "node:assert/strict";
import test from "node:test";

import { BundlerRpcError, BundlerTimeoutError } from "../../identity/lib/aa.ts";
import { Kernel033ChainRpcError } from "../../identity/lib/kernel033.ts";
import { PaymasterDeniedError } from "../../identity/lib/zerodev.ts";
import {
  ACTING_KIND_STORAGE_KEY,
  ActingStepError,
  accountGate,
  feesCoveredOn,
  passkeyActingLine,
  actingErrorDetails,
  actingErrorMessage,
  actingStepError,
  COULD_NOT_SEND_MESSAGE,
  FEE_BUSY_MESSAGE,
  FEE_REFUSED_MESSAGE,
  FEE_TOO_LARGE_MESSAGE,
  FEE_USED_UP_MESSAGE,
  NETWORK_DOWN_MESSAGE,
  NO_ANSWER_MESSAGE,
  NOT_CONFIRMED_MESSAGE,
  STILL_GOING_MESSAGE,
  WOULD_FAIL_MESSAGE,
  PartialStepError,
  sendAsAccount,
  StepRevertedError,
  chooseActingKind,
  loadActingKind,
  requireSponsoredSuccess,
  saveActingKind,
} from "./acting-account.ts";

test("a passkey account acts by default; a saved choice wins while it can still act", () => {
  const both = { passkey: true, wallet: true };
  assert.equal(chooseActingKind({ saved: null, ...both }), "passkey");
  assert.equal(chooseActingKind({ saved: "wallet", ...both }), "wallet");
  assert.equal(chooseActingKind({ saved: "passkey", ...both }), "passkey");
  // A saved choice that cannot act any more falls back to what can.
  assert.equal(
    chooseActingKind({ saved: "wallet", passkey: true, wallet: false }),
    "passkey",
  );
  assert.equal(
    chooseActingKind({ saved: "passkey", passkey: false, wallet: true }),
    "wallet",
  );
  assert.equal(
    chooseActingKind({ saved: null, passkey: false, wallet: false }),
    null,
  );
});

test("a sponsored step counts only when every operation in it succeeded", () => {
  const op = (success) => ({ success, txHash: "0xabc" });
  assert.equal(
    requireSponsoredSuccess({
      txHash: "0xabc",
      status: "confirmed",
      userOps: [op(true)],
    }),
    "0xabc",
  );
  for (const userOps of [[op(false)], [op(true), op(false)], []]) {
    assert.throws(
      () =>
        requireSponsoredSuccess({
          txHash: "0xabc",
          status: "confirmed",
          userOps,
        }),
      (error) =>
        error instanceof StepRevertedError &&
        error.txHash === "0xabc" &&
        /nothing changed/.test(error.message),
    );
  }
});

test("the choice is kept in this browser, and anything else stored there is ignored", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(loadActingKind(storage), null);
  saveActingKind("wallet", storage);
  assert.equal(store.get(ACTING_KIND_STORAGE_KEY), "wallet");
  assert.equal(loadActingKind(storage), "wallet");
  store.set(ACTING_KIND_STORAGE_KEY, "something else");
  assert.equal(loadActingKind(storage), null);
  const refusing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(loadActingKind(refusing), null);
  saveActingKind("passkey", refusing);
});

test("why the account cannot send yet, in words to act on", () => {
  const label = (id) => `net-${id}`;
  const base = {
    kind: "passkey",
    address: "0xabc",
    accountsChecked: true,
    chainId: 11155111,
    passkeyOffered: true,
  };
  assert.equal(accountGate(base, 11155111, label), null);
  assert.match(
    accountGate({ ...base, kind: null, address: null }, 1, label),
    /set up passkey sign-in from your profile menu/i,
  );
  assert.equal(
    accountGate(
      { ...base, kind: null, address: null, passkeyOffered: false },
      1,
      label,
    ),
    "Connect your wallet to act on this.",
  );
  assert.equal(
    accountGate(
      { ...base, address: null, accountsChecked: false },
      11155111,
      label,
    ),
    "Reading your passkey account…",
  );
  assert.match(
    accountGate({ ...base, address: null }, 11155111, label),
    /could not be read/,
  );
  assert.equal(
    accountGate({ ...base, kind: "wallet", address: null }, 1, label),
    "Connect your wallet to act on this.",
  );
  assert.equal(
    accountGate(base, 1, label),
    "Your passkey account works on net-11155111, but this is on net-1.",
  );
  assert.equal(
    accountGate({ ...base, kind: "wallet", chainId: 1 }, 11155111, label),
    "Your wallet is on net-1, but this is on net-11155111. Switch networks in your wallet.",
  );
  // A chain not known yet is not a reason to refuse.
  assert.equal(accountGate({ ...base, chainId: null }, 1, label), null);
  assert.equal(accountGate(base, null, label), null);
});

test("a passkey account's step is one operation, and one that failed inside is refused", async () => {
  const calls = [
    { to: "0x1", data: "0xaa" },
    { to: "0x2", data: "0xbb" },
  ];
  const seen = [];
  const sponsored = (success) => ({
    sendCalls: async (sent) => {
      seen.push(sent);
      return { txHash: "0xop", status: "confirmed", userOps: [{ success }] };
    },
  });
  assert.equal(
    await sendAsAccount({ kind: "passkey", calls, sponsored: sponsored(true) }),
    "0xop",
  );
  assert.deepEqual(seen[0], calls, "both calls in one operation");
  await assert.rejects(
    sendAsAccount({ kind: "passkey", calls, sponsored: sponsored(false) }),
    (error) => error instanceof StepRevertedError && error.txHash === "0xop",
  );
});

test("a wallet's step goes call by call, and a failure after one landed says part went through", async () => {
  const calls = [
    { to: "0x1", data: "0xaa" },
    { to: "0x2", data: "0xbb" },
    { to: "0x3", data: "0xcc" },
  ];
  const wallet = (fail) => {
    const sent = [];
    return {
      sent,
      walletSend: async (call) => {
        sent.push(call.to);
        if (fail[call.to] === "revert")
          return { txHash: `tx${call.to}`, status: "reverted" };
        if (fail[call.to] === "reject")
          throw Object.assign(new Error("User rejected"), { name: "Error" });
        return { txHash: `tx${call.to}`, status: "success" };
      },
    };
  };
  const ok = wallet({});
  assert.equal(
    await sendAsAccount({ kind: "wallet", calls, walletSend: ok.walletSend }),
    "tx0x3",
  );
  assert.deepEqual(ok.sent, ["0x1", "0x2", "0x3"]);
  // The first call refused: nothing changed.
  await assert.rejects(
    sendAsAccount({
      kind: "wallet",
      calls,
      walletSend: wallet({ "0x1": "revert" }).walletSend,
    }),
    (error) => error instanceof StepRevertedError && error.txHash === "tx0x1",
  );
  // A later one refused, or turned down in the wallet: part went through, and it stops there.
  const partly = wallet({ "0x2": "revert" });
  await assert.rejects(
    sendAsAccount({ kind: "wallet", calls, walletSend: partly.walletSend }),
    (error) =>
      error instanceof PartialStepError &&
      error.landed === 1 &&
      /Part of this went through/.test(error.message),
  );
  assert.deepEqual(partly.sent, ["0x1", "0x2"]);
  await assert.rejects(
    sendAsAccount({
      kind: "wallet",
      calls,
      walletSend: wallet({ "0x3": "reject" }).walletSend,
    }),
    (error) =>
      error instanceof PartialStepError &&
      error.landed === 2 &&
      /User rejected/.test(error.message),
  );
});

test("a failed send is said in plain words, never a browser's or a vendor's", () => {
  const closed = Object.assign(
    new Error(
      "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/",
    ),
    { name: "NotAllowedError" },
  );
  assert.match(actingErrorMessage(closed), /You closed the passkey prompt/);
  assert.doesNotMatch(actingErrorMessage(closed), /w3\.org/);
  const denied = new PaymasterDeniedError("policy cap reached");
  assert.match(actingErrorMessage(denied), /could not cover the fee/);
  assert.doesNotMatch(actingErrorMessage(denied), /ZeroDev|dashboard/i);
  assert.equal(
    actingErrorMessage(new StepRevertedError("0x")),
    "The network rejected that step, so nothing changed.",
  );
  assert.equal(
    actingErrorMessage(new Error("Your wallet is on another network.")),
    "Your wallet is on another network.",
  );
});

test("a passkey step's machinery is said in plain words, and a fee refusal that cannot pass never says try again", () => {
  const simulation = new BundlerRpcError(
    "bundler: zd_sponsorUserOperation RPC error UserOperation reverted during simulation with reason: 0x8baa579f",
  );
  assert.equal(actingErrorMessage(simulation), WOULD_FAIL_MESSAGE);
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError(
        "bundler: eth_estimateUserOperationGas RPC error execution reverted",
      ),
    ),
    WOULD_FAIL_MESSAGE,
  );
  assert.equal(
    actingErrorMessage(
      new Error("zerodev: no receipt for 0xabc after 90 polls (2000 ms apart)"),
    ),
    NOT_CONFIRMED_MESSAGE,
  );
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError(
        "bundler: eth_sendUserOperation RPC error AA25 invalid account nonce",
      ),
    ),
    STILL_GOING_MESSAGE,
  );
  assert.equal(
    actingErrorMessage(new BundlerTimeoutError(15_000)),
    NO_ANSWER_MESSAGE,
  );
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError("bundler: eth_sendUserOperation HTTP 503: busy", {
        retryable: true,
      }),
    ),
    NO_ANSWER_MESSAGE,
  );
  assert.equal(
    actingErrorMessage(
      new Kernel033ChainRpcError("eth_getCode", "HTTP 429: slow down"),
    ),
    NETWORK_DOWN_MESSAGE,
  );
  // The fee service: a step too big for the covered fee, a spending limit used up, or a refusal it did not explain.
  // None of them asks the person to try again in a few minutes: none of them passes by waiting.
  const tooBig = new PaymasterDeniedError("max gas limit exceeded for policy");
  const usedUp = new PaymasterDeniedError("policy cap reached");
  const refused = new PaymasterDeniedError("sponsorship denied");
  assert.equal(actingErrorMessage(tooBig), FEE_TOO_LARGE_MESSAGE);
  assert.equal(actingErrorMessage(usedUp), FEE_USED_UP_MESSAGE);
  assert.equal(actingErrorMessage(refused), FEE_REFUSED_MESSAGE);
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError(
        "bundler: eth_sendUserOperation RPC error AA31 paymaster deposit too low",
      ),
    ),
    FEE_USED_UP_MESSAGE,
  );
  for (const error of [
    simulation,
    tooBig,
    usedUp,
    refused,
    new Error("zerodev: something new"),
  ]) {
    const words = actingErrorMessage(error);
    assert.doesNotMatch(words, /bundler|zerodev|paymaster|0x|RPC|simulation/i);
    assert.doesNotMatch(words, /few minutes/);
  }
  for (const error of [tooBig, usedUp, refused]) {
    assert.match(actingErrorMessage(error), /could not cover the fee/);
    assert.match(
      actingErrorMessage(error),
      /Pressing again (will not|is unlikely to) help/,
    );
  }
});

test("the original text is kept for Technical details, and a step error carries both", () => {
  const raw =
    "bundler: zd_sponsorUserOperation RPC error UserOperation reverted during simulation with reason: 0x8baa579f";
  const error = new BundlerRpcError(raw);
  assert.equal(actingErrorDetails(error), raw);
  const onward = actingStepError(error);
  assert.ok(onward instanceof ActingStepError);
  assert.equal(onward.message, WOULD_FAIL_MESSAGE);
  assert.equal(onward.technical, raw);
  // Passing it on again keeps it as it is.
  assert.equal(actingStepError(onward), onward);
  assert.equal(actingErrorMessage(onward), WOULD_FAIL_MESSAGE);
  assert.equal(actingErrorDetails(onward), raw);
  // Words already written for people have no details, and a refusal on chain stays itself (callers read its hash).
  assert.equal(
    actingErrorDetails(new Error("Your wallet is on another network.")),
    null,
  );
  const reverted = new StepRevertedError("0xfeed");
  assert.equal(actingStepError(reverted), reverted);
});

test("a fee service asked too often says wait and press again, never that its limit is used up", () => {
  for (const text of [
    "rate limit exceeded",
    "Too Many Requests",
    "HTTP 429: slow down",
  ]) {
    assert.equal(
      actingErrorMessage(new PaymasterDeniedError(text)),
      FEE_BUSY_MESSAGE,
      text,
    );
  }
  assert.match(FEE_BUSY_MESSAGE, /nothing was sent/);
  assert.match(FEE_BUSY_MESSAGE, /press again/);
  // A spending limit used up is still that.
  assert.equal(
    actingErrorMessage(new PaymasterDeniedError("daily spend limit exceeded")),
    FEE_USED_UP_MESSAGE,
  );
  // The bundler asked too often: whether it went through is not known, so it says to look before pressing again.
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError(
        "bundler: eth_sendUserOperation RPC error rate limit exceeded",
      ),
    ),
    NO_ANSWER_MESSAGE,
  );
});

test("an account that could not be made (AA1x) is not called a step that was already done; AA2x and reverts still are", () => {
  for (const text of [
    "bundler: eth_sendUserOperation RPC error AA13 initCode failed or OOG",
    "bundler: zd_sponsorUserOperation RPC error UserOperation reverted during simulation with reason: AA10 sender already constructed",
  ]) {
    assert.equal(
      actingErrorMessage(new BundlerRpcError(text)),
      COULD_NOT_SEND_MESSAGE,
      text,
    );
  }
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError(
        "bundler: eth_sendUserOperation RPC error AA23 reverted (or OOG)",
      ),
    ),
    WOULD_FAIL_MESSAGE,
  );
  assert.equal(
    actingErrorMessage(
      new BundlerRpcError(
        "bundler: eth_estimateUserOperationGas RPC error execution reverted",
      ),
    ),
    WOULD_FAIL_MESSAGE,
  );
});

test("the passkey fee promise names the network it is true on, and makes none without one", () => {
  assert.equal(feesCoveredOn(11155111), "the test network");
  assert.equal(feesCoveredOn(8453), "Base");
  assert.equal(feesCoveredOn(null), null);
  assert.equal(feesCoveredOn(0), null);
  assert.equal(
    passkeyActingLine(11155111),
    "You act with your account (passkey; fees are covered on the test network).",
  );
  assert.equal(
    passkeyActingLine(8453),
    "You act with your account (passkey; fees are covered on Base).",
  );
  assert.equal(passkeyActingLine(null), "You act with your account (passkey).");
  const none = {
    kind: null,
    address: null,
    accountsChecked: true,
    chainId: null,
    passkeyOffered: true,
  };
  const label = (id) => `net-${id}`;
  const onBase = accountGate(none, 8453, label, feesCoveredOn(8453));
  assert.match(onBase, /fees are covered on Base\)/);
  assert.doesNotMatch(onBase, /test network/);
  assert.equal(
    accountGate(none, 1, label, null),
    "Set up passkey sign-in from your profile menu to act here, or add a wallet to this browser.",
  );
});
