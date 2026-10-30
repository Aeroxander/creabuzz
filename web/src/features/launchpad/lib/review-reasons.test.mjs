import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundWallets,
  parseReviewReason,
  REASON_MAX_CHARS,
  reasonProblem,
  reasonsFor,
  reasonWouldShow,
  reviewReasonContent,
} from "./review-reasons.ts";

const CLAIM = `0x${"77".repeat(32)}`;
const BUDGET = `0x${"b1".repeat(20)}`;
const RUI = `0x${"a1".repeat(20)}`;
const RAE = `0x${"a2".repeat(20)}`;
const RUI_KEY = "1".repeat(64);
const RAE_KEY = "2".repeat(64);
const STRANGER_KEY = "9".repeat(64);

const event = (
  pubkey,
  created_at,
  content,
  id = `${pubkey}-${created_at}`,
) => ({
  id,
  pubkey,
  created_at,
  content: JSON.stringify(content),
});
const reasonEvent = (pubkey, reviewer, text, at = 10) =>
  event(
    pubkey,
    at,
    reviewReasonContent({
      name: "translate",
      claimId: CLAIM,
      mandate: BUDGET,
      reviewer,
      reason: text,
    }),
  );

test("a reason is published as an update that names the claim, the budget and the reviewer, and reads back", () => {
  const content = reviewReasonContent({
    name: "translate",
    claimId: CLAIM.toUpperCase().replace("0X", "0x"),
    mandate: BUDGET,
    reviewer: RUI.toUpperCase().replace("0X", "0x"),
    reason: "  The German page is missing. See https://example.com/pr/2.  ",
  });
  assert.equal(content.title, "Turned down: translate");
  assert.equal(
    content.body,
    "The German page is missing. See https://example.com/pr/2.",
  );
  assert.deepEqual(content.links, ["https://example.com/pr/2"]);
  assert.deepEqual(content.review, {
    id: CLAIM,
    mandate: BUDGET,
    reviewer: RUI,
    verdict: "object",
  });
  const parsed = parseReviewReason(event(RUI_KEY, 5, content));
  assert.equal(parsed?.reviewer, RUI);
  assert.equal(parsed?.claimId, CLAIM);
  assert.equal(parsed?.reason, content.body);
  // Evidence updates, words updates, broken ones, and empty reasons are not reasons.
  assert.equal(
    parseReviewReason(
      event(RUI_KEY, 5, { title: "x", body: "y", claim: { id: CLAIM } }),
    ),
    null,
  );
  assert.equal(
    parseReviewReason({
      id: "x",
      pubkey: RUI_KEY,
      created_at: 1,
      content: "{",
    }),
    null,
  );
  assert.equal(
    parseReviewReason(event(RUI_KEY, 5, { ...content, body: "  " })),
    null,
  );
  assert.equal(
    parseReviewReason(
      event(RUI_KEY, 5, {
        ...content,
        review: { ...content.review, reviewer: "me" },
      }),
    ),
    null,
  );
  assert.equal(reasonProblem("fine"), null);
  assert.equal(reasonProblem(""), null, "a reason is optional");
  assert.match(
    reasonProblem("x".repeat(REASON_MAX_CHARS + 1)) ?? "",
    /under 2,000/,
  );
});

test("only a reason tied to a real turn-down is shown: the wallet turned it down, and its signer bound that wallet", () => {
  const reasons = [
    reasonEvent(RUI_KEY, RUI, "first try", 10),
    reasonEvent(RUI_KEY, RUI, "the German page is missing", 20),
    // Someone else names Rui's wallet: never shown as Rui's.
    reasonEvent(STRANGER_KEY, RUI, "forged", 30),
    // Rae approved: a reason from her is not a turn-down's.
    reasonEvent(RAE_KEY, RAE, "should not show", 15),
  ].map(parseReviewReason);
  const bound = boundWallets([
    {
      pubkey: RUI_KEY,
      address: RUI,
      revoked: false,
      createdAt: 1,
      eventId: "a",
    },
    {
      pubkey: RAE_KEY,
      address: RAE,
      revoked: false,
      createdAt: 1,
      eventId: "b",
    },
  ]);
  const shown = reasonsFor(
    { id: CLAIM, mandate: BUDGET },
    reasons,
    [RUI],
    bound,
  );
  assert.deepEqual(
    shown.map((r) => r.reason),
    ["the German page is missing"],
    "the newest from the reviewer who turned it down",
  );
  // While who turned it down is not known, nothing is shown.
  assert.deepEqual(
    reasonsFor({ id: CLAIM, mandate: BUDGET }, reasons, null, bound),
    [],
  );
  // Another budget's claim with the same id is another claim.
  assert.deepEqual(
    reasonsFor(
      { id: CLAIM, mandate: `0x${"b2".repeat(20)}` },
      reasons,
      [RUI],
      bound,
    ),
    [],
  );
  // A binding withdrawn later unbinds the wallet.
  const withdrawn = boundWallets([
    {
      pubkey: RUI_KEY,
      address: RUI,
      revoked: false,
      createdAt: 1,
      eventId: "a",
    },
    {
      pubkey: RUI_KEY,
      address: RUI,
      revoked: true,
      createdAt: 2,
      eventId: "c",
    },
  ]);
  assert.deepEqual(
    reasonsFor({ id: CLAIM, mandate: BUDGET }, reasons, [RUI], withdrawn),
    [],
  );
  // A person with two wallets bound keeps both: the older binding is not dropped for the newer one.
  const both = boundWallets([
    {
      pubkey: RUI_KEY,
      address: RAE,
      revoked: false,
      createdAt: 5,
      eventId: "d",
    },
    {
      pubkey: RUI_KEY,
      address: RUI,
      revoked: false,
      createdAt: 1,
      eventId: "a",
    },
  ]);
  assert.equal(both.has(`${RUI_KEY}:${RUI}`), true);
});

test("before a reason is published, the form asks what the filter asks: is the signer's key bound to the acting wallet (D145)", () => {
  const bound = boundWallets([
    {
      pubkey: RUI_KEY,
      address: RUI.toUpperCase().replace("0X", "0x"),
      revoked: false,
      createdAt: 1,
      eventId: "a",
    },
    {
      pubkey: RAE_KEY,
      address: RAE,
      revoked: false,
      createdAt: 1,
      eventId: "b",
    },
    {
      pubkey: RAE_KEY,
      address: RAE,
      revoked: true,
      createdAt: 2,
      eventId: "c",
    },
  ]);
  // Rui is linked to the wallet he acts from, whatever its case.
  assert.equal(
    reasonWouldShow(bound, RUI_KEY, RUI.toUpperCase().replace("0X", "0x")),
    true,
  );
  // Acting from another account (a passkey account he never linked): his reason would be filtered out.
  assert.equal(reasonWouldShow(bound, RUI_KEY, RAE), false);
  // Rae withdrew her link: not shown.
  assert.equal(reasonWouldShow(bound, RAE_KEY, RAE), false);
  // The same answer the filter gives for a published reason.
  const reasons = [
    reasonEvent(RUI_KEY, RAE, "from an account not linked", 10),
  ].map(parseReviewReason);
  assert.deepEqual(
    reasonsFor({ id: CLAIM, mandate: BUDGET }, reasons, [RAE], bound),
    [],
  );
});
