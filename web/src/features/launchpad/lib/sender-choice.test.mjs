import assert from "node:assert/strict";
import test from "node:test";

import { StepRevertedError } from "./acting-account.ts";
import { resolveSender } from "./sender-choice.ts";

test("a passkey account's operation that failed inside is refused on every picker screen (D139)", async () => {
  const sponsored = (success) => ({
    getAddress: async () => "0xaccount",
    isAvailable: () => true,
    sendCalls: async () => ({
      txHash: "0xop",
      status: "confirmed",
      userOps: [{ success }],
    }),
  });
  const ok = resolveSender({
    kind: "passkey",
    wallet: undefined,
    sponsoredSender: sponsored(true),
  });
  assert.equal(
    (await ok.sendCalls([{ to: "0x1", data: "0x" }])).txHash,
    "0xop",
  );
  assert.equal(await ok.getAddress(), "0xaccount");
  const failed = resolveSender({
    kind: "passkey",
    wallet: undefined,
    sponsoredSender: sponsored(false),
  });
  await assert.rejects(
    failed.sendCalls([{ to: "0x1", data: "0x" }]),
    (error) => error instanceof StepRevertedError,
  );
});
