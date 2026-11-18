import assert from "node:assert/strict";
import { test } from "node:test";

import { makeSponsoredSender } from "./passkey-sender.ts";

test("a passkey sender made for any page tells the error collector when a send fails, and still fails", async () => {
  const told = [];
  // No passkey in this browser: the send cannot go, which is a failure the organiser hears about.
  const sender = makeSponsoredSender(
    { chainId: 11155111, rpcUrl: "http://node.test", credentialId: undefined },
    (cause, error) => told.push([cause, error]),
  );
  await assert.rejects(
    sender.sendCalls([{ to: `0x${"11".repeat(20)}`, data: "0x" }]),
  );
  assert.equal(told.length, 1);
  assert.match(told[0][0], /^sponsor-/);
  // The rest of the sender is the same one.
  assert.equal(typeof sender.availability, "function");
  assert.equal(sender.availability().available, false);
});
