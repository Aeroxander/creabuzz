/**
 * `voteTx.ts` under `node --test` (node >= 22 strip-types). Goldens from
 * `cast sig` / `cast calldata` / `cast keccak` — copied verbatim from web's
 * `web/src/features/launchpad/lib/vote-tx.test.mjs`, the same vectors
 * `contracts/script/JourneyGov.s.sol` binds onchain.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProposalActionCall,
  computeProposalId,
  decodeProposalState,
  encodeCastVote,
  encodeExecuteByVotes,
  encodeOpenProposal,
  encodeProposalIdView,
  encodeQueue,
  encodeStateView,
  parseProposalIntent,
  PROPOSAL_STATES,
  SELECTOR_CAST_VOTE,
  SELECTOR_EXECUTE_BY_VOTES,
  SELECTOR_OPEN_PROPOSAL,
  SELECTOR_PROPOSAL_ID,
  SELECTOR_QUEUE,
  SELECTOR_STATE,
  VOTE_FOR,
} from "./voteTx.ts";

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

  it("decodeProposalState maps the state word to its label", () => {
    const word = `0x${1n.toString(16).padStart(64, "0")}`;
    assert.equal(decodeProposalState(word), "Active");
    assert.throws(() => decodeProposalState(`0x${"ff".repeat(32)}`), /unknown/);
  });
});

describe("parseProposalIntent — the record-carried operation", () => {
  it("accepts a well-formed operation", () => {
    assert.deepEqual(parseProposalIntent({ ...INTENT, value: "5" }), {
      op: 0,
      to: TO,
      value: "5",
      data: "0x123456",
      nonce: NONCE,
    });
  });

  it("rejects malformed shapes without throwing", () => {
    assert.equal(parseProposalIntent(null), null);
    assert.equal(parseProposalIntent("nope"), null);
    assert.equal(parseProposalIntent({ ...INTENT, op: 2 }), null);
    assert.equal(parseProposalIntent({ ...INTENT, nonce: "0x12" }), null);
    assert.equal(parseProposalIntent({ ...INTENT, to: "0xdead" }), null);
  });
});

describe("buildProposalActionCall — the panel's lifecycle actions", () => {
  it("composes vote/queue/open against the DAO and gates execute on the operation", () => {
    const vote = buildProposalActionCall({
      dao: DAO,
      proposalId: "1",
      action: "vote-for",
    });
    assert.equal(vote.to, DAO);
    assert.equal(vote.data, encodeCastVote(1n, VOTE_FOR));
    assert.equal(vote.value, "0x0");
    assert.equal(
      buildProposalActionCall({ dao: DAO, proposalId: "1", action: "queue" })
        .data,
      encodeQueue(1n),
    );
    assert.equal(
      buildProposalActionCall({ dao: DAO, proposalId: "1", action: "open" })
        .data,
      encodeOpenProposal(1n),
    );
    const execute = buildProposalActionCall({
      dao: DAO,
      proposalId: "1",
      action: "execute",
      intent: INTENT,
    });
    assert.equal(execute.data, encodeExecuteByVotes(INTENT));
    assert.throws(
      () =>
        buildProposalActionCall({
          dao: DAO,
          proposalId: "1",
          action: "execute",
        }),
      /execute needs the recorded operation/,
    );
  });
});
