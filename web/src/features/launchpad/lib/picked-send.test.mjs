import assert from "node:assert/strict";
import { test } from "node:test";

import { BundlerRpcError } from "../../identity/lib/aa.ts";
import {
  ActingStepError,
  StepRevertedError,
  WOULD_FAIL_MESSAGE,
} from "./acting-account.ts";
import { sendPicked } from "./picked-send.ts";

const CHAIN = 11155111;
const call = { to: `0x${"da".repeat(20)}`, data: "0x", value: "0x0" };
const label = (id) => `network ${id}`;

test("a screen's own picker fails in the same words as the acting account, with the original kept for Technical details", async () => {
  const raw =
    "bundler: zd_sponsorUserOperation RPC error UserOperation reverted during simulation with reason: 0x8baa579f";
  const failure = await sendPicked({
    kind: "passkey",
    calls: [call],
    chainId: CHAIN,
    passkey: {
      chainId: CHAIN,
      sendCalls: async () => {
        throw new BundlerRpcError(raw);
      },
    },
    wallet: undefined,
    label,
  }).catch((error) => error);
  assert.ok(failure instanceof ActingStepError);
  assert.equal(failure.message, WOULD_FAIL_MESSAGE);
  assert.equal(failure.technical, raw);
});

test("a step the chain refused stays a refusal, so the screen can read its transaction", async () => {
  const failure = await sendPicked({
    kind: "passkey",
    calls: [call],
    chainId: CHAIN,
    passkey: {
      chainId: CHAIN,
      sendCalls: async () => ({
        txHash: `0x${"ab".repeat(32)}`,
        status: "confirmed",
        userOps: [{ success: false }],
      }),
    },
    wallet: undefined,
    label,
  }).catch((error) => error);
  assert.ok(failure instanceof StepRevertedError);
  assert.equal(failure.txHash, `0x${"ab".repeat(32)}`);
});
