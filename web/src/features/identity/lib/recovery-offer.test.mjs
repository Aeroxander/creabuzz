import assert from "node:assert/strict";
import test from "node:test";

import {
  closeRecoveryOffer,
  offerRecoveryKey,
  pendingRecoveryOffer,
  subscribeRecoveryOffer,
} from "./recovery-offer.ts";

test("the offer stays open until it is closed, then runs the caller's follow-up once", () => {
  const followUps = [];
  const heard = [];
  const stop = subscribeRecoveryOffer(() => heard.push(pendingRecoveryOffer()));
  const offer = { account: "a".repeat(64), onClose: () => followUps.push("a") };

  offerRecoveryKey(offer);
  assert.equal(pendingRecoveryOffer(), offer);
  assert.deepEqual(followUps, []);

  closeRecoveryOffer(offer);
  assert.equal(pendingRecoveryOffer(), null);
  assert.deepEqual(followUps, ["a"]);
  // A second close (a double click) does not run the follow-up again.
  closeRecoveryOffer(offer);
  assert.deepEqual(followUps, ["a"]);
  assert.deepEqual(heard, [offer, null]);
  stop();
});

test("a newer offer replaces the open one, and closing the replaced one does nothing", () => {
  const followUps = [];
  const first = { account: "a".repeat(64), onClose: () => followUps.push(1) };
  const second = { account: "b".repeat(64), onClose: () => followUps.push(2) };
  offerRecoveryKey(first);
  offerRecoveryKey(second);
  closeRecoveryOffer(first);
  assert.equal(pendingRecoveryOffer(), second);
  assert.deepEqual(followUps, []);
  closeRecoveryOffer(second);
  assert.equal(pendingRecoveryOffer(), null);
  assert.deepEqual(followUps, [2]);
});
