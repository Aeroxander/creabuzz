import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAVE_SOON_SECONDS,
  positionNeeds,
  positionOf,
} from "./backing-positions.ts";
import { needWords, orderNeeds } from "./project-state.ts";

const quote = { address: "0x", decimals: 6, symbol: "tTEST" };
const NOW = 1_800_000_000;

const view = (over = {}, roundOver = {}, milestoneOver = {}) => ({
  kind: "pool",
  phase: "live",
  quote,
  snapshot: {
    holderUnits: 5n,
    holderSellValue: 90n,
    holderEscrow: 10n,
    holderCanLeave: false,
    milestone: { status: "none", windowEndsAt: 0, ...milestoneOver },
    round: { state: "none", holderClaimTokens: 0n, ...roundOver },
    ...over,
  },
});
const open = (endsIn) => ({
  holderCanLeave: true,
  milestone: { status: "open", windowEndsAt: NOW + endsIn },
});

test("a position is what the person holds, and nothing when they hold nothing", () => {
  assert.equal(
    positionOf(view({ holderUnits: 0n, holderEscrow: 0n }), NOW),
    null,
  );
  const p = positionOf(view(), NOW);
  assert.deepEqual(
    {
      units: p.units,
      sellValue: p.sellValue,
      held: p.held,
      leaveBy: p.leaveBy,
      claim: p.claimTokens,
    },
    { units: 5n, sellValue: 90n, held: 10n, leaveBy: null, claim: 0n },
  );
  // Round tokens alone are a position too: they can become units.
  assert.ok(
    positionOf(
      view(
        { holderUnits: 0n, holderEscrow: 0n },
        { state: "live", holderClaimTokens: 3n },
      ),
      NOW,
    ),
  );
  // Tokens of a round that has not settled are not exchangeable yet.
  assert.equal(
    positionOf(
      view(
        { holderUnits: 0n, holderEscrow: 0n },
        { state: "waiting", holderClaimTokens: 3n },
      ),
      NOW,
    ),
    null,
  );
});

test("a window the person may use gives a leave-by date; one that has closed, or that they may not use, gives none", () => {
  assert.equal(positionOf(view(open(86_400)), NOW).leaveBy, NOW + 86_400);
  assert.equal(positionOf(view(open(-1)), NOW).leaveBy, null);
  assert.equal(
    positionOf(view({ ...open(86_400), holderCanLeave: false }), NOW).leaveBy,
    null,
  );
});

test("the next step shows only for a window about to end, and for round tokens ready to exchange", () => {
  const near = positionOf(view(open(LEAVE_SOON_SECONDS)), NOW);
  assert.deepEqual(positionNeeds("c", near, NOW), [
    { kind: "leave-by", coordinate: "c", leaveBy: NOW + LEAVE_SOON_SECONDS },
  ]);
  const far = positionOf(view(open(LEAVE_SOON_SECONDS + 1)), NOW);
  assert.deepEqual(positionNeeds("c", far, NOW), []);
  const claim = positionOf(
    view({}, { state: "live", holderClaimTokens: 1n }),
    NOW,
  );
  assert.deepEqual(positionNeeds("c", claim, NOW), [
    { kind: "round-claim", coordinate: "c" },
  ]);
  assert.deepEqual(positionNeeds("c", positionOf(view(), NOW), NOW), []);
});

test("the new needs have plain words and sit between what others wait on and what only helps the person", () => {
  const leave = { kind: "leave-by", coordinate: "c", leaveBy: NOW };
  const claim = { kind: "round-claim", coordinate: "c" };
  assert.match(
    needWords(leave, "Docs").text,
    /^A milestone of Docs is open\. Until .+ you can stay, or leave and take your held money back\.$/,
  );
  assert.equal(needWords(leave, "Docs").action, "Stay or leave");
  assert.match(
    needWords(claim, "Docs").text,
    /round tokens can now be exchanged for backing units/,
  );
  const ordered = orderNeeds([
    { kind: "update-due", coordinate: "c", days: 9 },
    claim,
    leave,
    { kind: "check", coordinate: "c", taskId: "t", what: "x" },
  ]);
  assert.deepEqual(
    ordered.map((n) => n.kind),
    ["check", "leave-by", "round-claim", "update-due"],
  );
});
