import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseProposalTopic,
  proposalOf,
  proposalTopic,
  sameProposal,
} from "./proposal-link.ts";

const DAO = `0x${"ab".repeat(20)}`;
const ID = `0x${"0f".repeat(32)}`;

describe("proposal topics", () => {
  it("round-trips a decision", () => {
    const topic = proposalTopic({
      chainId: 31337,
      dao: DAO.toUpperCase().replace("0X", "0x"),
      id: ID,
    });
    assert.equal(topic, `proposal:31337:${DAO}:${ID}`);
    assert.deepEqual(parseProposalTopic(topic), {
      chainId: 31337,
      dao: DAO,
      id: ID,
    });
  });

  it("refuses anything that is not exactly a decision", () => {
    assert.equal(proposalTopic({ chainId: 0, dao: DAO, id: ID }), null);
    assert.equal(proposalTopic({ chainId: 1, dao: "0x12", id: ID }), null);
    assert.equal(proposalTopic({ chainId: 1, dao: DAO, id: "0x12" }), null);
    for (const bad of [
      "proposal",
      `proposal:1:${DAO}`,
      `proposal:01:${DAO}:${ID}`,
      `proposal:1:${DAO}:${ID}:x`,
      `other:1:${DAO}:${ID}`,
      `proposal:1:${DAO.toUpperCase()}:${ID}`,
      `proposal:1.5:${DAO}:${ID}`,
    ]) {
      assert.equal(parseProposalTopic(bad), null, bad);
    }
  });
});

describe("proposalOf", () => {
  const topic = `proposal:1:${DAO}:${ID}`;
  it("reads the one decision a post names", () => {
    assert.deepEqual(
      proposalOf([
        ["h", "c"],
        ["t", "proposal"],
        ["t", topic],
      ]),
      {
        chainId: 1,
        dao: DAO,
        id: ID,
      },
    );
  });
  it("ignores a post that names none, or more than one (it cannot be trusted to be about either)", () => {
    assert.equal(proposalOf([["t", "proposal"]]), null);
    assert.equal(
      proposalOf([
        ["t", topic],
        ["t", `proposal:2:${DAO}:${ID}`],
      ]),
      null,
    );
    assert.equal(proposalOf([["t", "proposal:junk"]]), null);
  });
  it("compares decisions", () => {
    const a = { chainId: 1, dao: DAO, id: ID };
    assert.equal(sameProposal(a, { ...a }), true);
    assert.equal(sameProposal(a, { ...a, chainId: 2 }), false);
  });
});
