/**
 * `vote-tx.ts` under `node --test` (node >= 22 strip-types). Goldens from
 * `cast sig` / `cast calldata` / `cast keccak` — the same vectors
 * `contracts/script/JourneyGov.s.sol` binds onchain.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeProposalId,
  encodeCastVote,
  encodeDelegate,
  encodeDelegatesView,
  encodeExecuteByVotes,
  encodeOpenProposal,
  encodeProposalIdView,
  encodeQueue,
  encodeStateView,
  PROPOSAL_STATES,
  SELECTOR_CAST_VOTE,
  SELECTOR_DELEGATE,
  SELECTOR_DELEGATES,
  SELECTOR_EXECUTE_BY_VOTES,
  SELECTOR_OPEN_PROPOSAL,
  SELECTOR_PROPOSAL_ID,
  SELECTOR_QUEUE,
  SELECTOR_STATE,
  VOTE_FOR,
} from "./vote-tx.ts";

const DAO = "0x00000000000000000000000000000000000000Aa";
const TO = "0x000000000000000000000000000000000000dEaD";
const NONCE = `0x${"11".repeat(32)}`;
const INTENT = { op: 0, to: TO, value: 0n, data: "0x123456", nonce: NONCE };

describe("selectors pinned to cast sig", () => {
  it("openProposal / castVote / queue / executeByVotes / proposalId / state", () => {
    assert.equal(SELECTOR_OPEN_PROPOSAL, "0x31288f40");
    assert.equal(SELECTOR_CAST_VOTE, "0x56781388");
    assert.equal(SELECTOR_QUEUE, "0xddf0b009");
    assert.equal(SELECTOR_EXECUTE_BY_VOTES, "0xee5b2895");
    assert.equal(SELECTOR_PROPOSAL_ID, "0x997506ba");
    assert.equal(SELECTOR_STATE, "0x3e4f49e6");
  });
});

describe("computeProposalId — the offline hash is the onchain id", () => {
  it("matches the cast keccak vector (config binds bumpConfig rotation)", () => {
    // cast keccak of cast abi-encode("f(address,uint8,address,uint256,bytes32,bytes32,uint64)", ...)
    assert.equal(
      computeProposalId(DAO, INTENT, 7),
      "0x1ef9e68851a9100c57c03308fafc22b2f4fb2a0a4f1cd4ae38f0a9c2f6b1746c",
    );
  });

  it("a config bump changes every open id (emergency invalidate)", () => {
    assert.notEqual(
      computeProposalId(DAO, INTENT, 8),
      computeProposalId(DAO, INTENT, 7),
    );
  });
});

describe("cast calldata goldens", () => {
  it("executeByVotes with dynamic bytes", () => {
    // Verbatim `cast calldata` output.
    assert.equal(
      encodeExecuteByVotes(INTENT),
      "0xee5b28950000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000031234560000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("castVote(1, for)", () => {
    assert.equal(
      encodeCastVote(1n, VOTE_FOR),
      "0x56781388" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("openProposal(1) / queue(1) / state(1)", () => {
    assert.equal(
      encodeOpenProposal(1n),
      "0x31288f400000000000000000000000000000000000000000000000000000000000000001",
    );
    assert.equal(
      encodeQueue(1n),
      "0xddf0b0090000000000000000000000000000000000000000000000000000000000000001",
    );
    assert.equal(
      encodeStateView(1n),
      "0x3e4f49e60000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("delegate(address) — selectors pinned to cast; padding by construction", () => {
    // The address word is 60 zeros + `dead` (64 hex) — arithmetic, not
    // paste-fragile counting. Selectors come from `cast sig`.
    const word = "0".repeat(60) + "dead";
    assert.equal(
      encodeDelegate("0x000000000000000000000000000000000000dEaD"),
      `0x5c19a95c${word}`,
    );
    assert.equal(
      encodeDelegatesView("0x000000000000000000000000000000000000dEaD"),
      `0x587cde1e${word}`,
    );
  });

  it("proposalId view shares executeByVotes' argument layout", () => {
    const view = encodeProposalIdView(INTENT);
    const exec = encodeExecuteByVotes(INTENT);
    assert.ok(view.startsWith(SELECTOR_PROPOSAL_ID));
    assert.ok(exec.startsWith(SELECTOR_EXECUTE_BY_VOTES));
    assert.equal(view.slice(10), exec.slice(10), "same five-argument layout");
  });

  it("empty data encodes length 0 with no tail word", () => {
    const exec = encodeExecuteByVotes({ ...INTENT, data: "0x" });
    // selector + 5 head words + the zero length word, and nothing after.
    assert.equal(exec.length, 10 + 64 * 6);
    assert.ok(exec.endsWith("0".repeat(64)));
  });
});

describe("validation and labels", () => {
  it("refuses malformed words and support values", () => {
    assert.throws(() => encodeOpenProposal(-1n), /uint256/);
    assert.throws(() => encodeCastVote(1n, 3), /support must be/);
    assert.throws(
      () => encodeExecuteByVotes({ ...INTENT, nonce: "0x1234" }),
      /nonce must be 0x \+ 64 hex/,
    );
    assert.throws(
      () => computeProposalId("0xdead", INTENT, 7),
      /dao must be 0x \+ 40 hex/,
    );
  });

  it("ProposalState labels follow majeur's declaration order", () => {
    assert.deepEqual(
      [...PROPOSAL_STATES],
      [
        "Unopened",
        "Active",
        "Queued",
        "Succeeded",
        "Defeated",
        "Expired",
        "Executed",
      ],
    );
  });
});
