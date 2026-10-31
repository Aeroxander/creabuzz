import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTION_SIGNATURES } from "@creaton/core/launchpad/daoActions.ts";
import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import { hashText, idWord } from "@creaton/core/launchpad/work.ts";

import {
  cannotOpenDecision,
  cannotOpenLine,
  mayOfferVote,
  openVoteFor,
  whoMayOpen,
} from "./proposal-gate.ts";

const E18 = 10n ** 18n;

test("an account known to hold too few votes is not offered to open a vote; an unknown one is not refused", () => {
  assert.equal(cannotOpenDecision(undefined), false);
  assert.equal(
    cannotOpenDecision({ proposalThreshold: E18, walletCapacity: null }),
    false,
  );
  assert.equal(
    cannotOpenDecision({ proposalThreshold: 0n, walletCapacity: 0n }),
    true,
  );
  assert.equal(
    cannotOpenDecision({
      proposalThreshold: 10n * E18,
      walletCapacity: 9n * E18,
    }),
    true,
  );
  assert.equal(
    cannotOpenDecision({
      proposalThreshold: 10n * E18,
      walletCapacity: 10n * E18,
    }),
    false,
  );
  assert.equal(
    whoMayOpen({ proposalThreshold: 5000n * E18, walletCapacity: 0n }),
    "Holders of 5,000 Shares or more",
  );
  assert.equal(
    whoMayOpen({ proposalThreshold: 1n, walletCapacity: 0n }),
    "Holders of 1 Share or more",
  );
});

const approve = (name, words) =>
  encodeFunctionData(
    ACTION_SIGNATURES.approveProject,
    ["bytes32", "address", "uint128", "uint128", "uint64", "bytes32"],
    [
      idWord(name),
      `0x${"f0".repeat(20)}`,
      0n,
      100n * E18,
      9_999n,
      hashText(words),
    ],
  );

test("a suggestion with a live vote to approve it (same short name and words) is found; others are not", () => {
  const area = {
    projectId: idWord("garden-guide"),
    checkHash: hashText("a two-page guide"),
  };
  const decisions = [
    {
      id: "0xdone",
      state: "Executed",
      action: { data: approve("garden-guide", "a two-page guide") },
    },
    {
      id: "0xother",
      state: "Active",
      action: { data: approve("garden-guide", "other words") },
    },
    {
      id: "0xopen",
      state: "Active",
      action: { data: approve("garden-guide", "a two-page guide") },
    },
  ];
  assert.equal(openVoteFor(decisions, area), "0xopen");
  assert.equal(openVoteFor(decisions.slice(0, 2), area), null);
  assert.equal(
    openVoteFor([{ id: "0xq", state: "Queued", action: null }], area),
    null,
  );
});

test("a freeze or unwind is offered only to a signed-in person with a wallet that may open a vote, never to a visitor", () => {
  const enough = { proposalThreshold: E18, walletCapacity: 2n * E18 };
  const few = { proposalThreshold: E18, walletCapacity: 0n };
  const unread = { proposalThreshold: E18, walletCapacity: null };
  const member = {
    signedIn: true,
    wallet: "0x1111111111111111111111111111111111111111",
  };
  // A visitor: no account, no wallet, so the read knows nothing about them. Not offered.
  assert.equal(mayOfferVote(unread, { signedIn: false, wallet: null }), false);
  assert.equal(
    mayOfferVote(undefined, { signedIn: false, wallet: null }),
    false,
  );
  // Signed in without a wallet, or a wallet without an account: not offered.
  assert.equal(mayOfferVote(enough, { signedIn: true, wallet: null }), false);
  assert.equal(mayOfferVote(enough, { ...member, signedIn: false }), false);
  // A member with a wallet: offered unless the read shows too few votes.
  assert.equal(mayOfferVote(enough, member), true);
  assert.equal(mayOfferVote(unread, member), true);
  assert.equal(mayOfferVote(few, member), false);
});

test("someone who cannot open a decision is told how many Shares it takes and how many they hold", () => {
  assert.equal(
    cannotOpenLine({ proposalThreshold: 1000n * E18, walletCapacity: 0n }),
    "You need 1,000 Shares to open a decision. You hold 0.",
  );
  assert.equal(
    cannotOpenLine({ proposalThreshold: 0n, walletCapacity: 0n }),
    "You need 1 Share to open a decision. You hold 0.",
  );
  // Able, or not known yet: nothing to say.
  assert.equal(
    cannotOpenLine({
      proposalThreshold: 1000n * E18,
      walletCapacity: 2000n * E18,
    }),
    null,
  );
  assert.equal(
    cannotOpenLine({ proposalThreshold: 1000n * E18, walletCapacity: null }),
    null,
  );
  assert.equal(cannotOpenLine(undefined), null);
});
