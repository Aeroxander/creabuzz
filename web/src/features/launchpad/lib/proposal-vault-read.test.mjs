/**
 * `proposal-vault-read.ts` under `node --test`.
 *
 * The decoders assume the `Proposal` struct comes back as seven words in
 * declaration order. That is not a safe thing to assume quietly — a reordered
 * struct would silently read the wrong numbers into a backer's screen. So the
 * order is pinned to the COMPILED artifact's ABI here.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeAmount,
  decodeProposal,
  decodeWeight,
  isAddress,
  parseProposalOpened,
  TOPIC_PROPOSAL_OPENED,
} from "./proposal-vault-read.ts";

const WORDS = (...values) =>
  `0x${values.map((v) => BigInt(v).toString(16).padStart(64, "0")).join("")}`;

const PROPOSAL_ID =
  "0x6d31000000000000000000000000000000000000000000000000000000000000";

describe("a ProposalOpened log", () => {
  it("reads the id from the topic and the parameters from the data", () => {
    const parsed = parseProposalOpened({
      topics: [TOPIC_PROPOSAL_OPENED, PROPOSAL_ID],
      data: WORDS(100, 10_000, 512, 7),
    });
    assert.deepEqual(parsed, {
      proposalId: PROPOSAL_ID,
      minAmount: "100",
      maxAmount: "10000",
      deadline: 512,
      checkHash: `0x${BigInt(7).toString(16).padStart(64, "0")}`,
    });
  });

  it("ignores a log from a different event", () => {
    assert.equal(
      parseProposalOpened({
        topics: [`0x${"ab".repeat(32)}`, PROPOSAL_ID],
        data: WORDS(1, 2, 3, 4),
      }),
      null,
    );
  });

  it("ignores a truncated log rather than inventing numbers", () => {
    assert.equal(
      parseProposalOpened({ topics: [TOPIC_PROPOSAL_OPENED], data: WORDS(1) }),
      null,
    );
    assert.equal(
      parseProposalOpened({
        topics: [TOPIC_PROPOSAL_OPENED, PROPOSAL_ID],
        data: "0x",
      }),
      null,
    );
  });
});

describe("a proposals() return", () => {
  it("reads the seven fields in declaration order", () => {
    const decoded = decodeProposal(
      PROPOSAL_ID,
      WORDS(100, 10_000, 512, 7, 950, 475, 0),
    );
    assert.deepEqual(decoded, {
      id: PROPOSAL_ID,
      checkHash: `0x${BigInt(7).toString(16).padStart(64, "0")}`,
      minAmount: "100",
      maxAmount: "10000",
      deadline: 512,
      reserved: "950",
      state: "open",
    });
  });

  it("refuses a state outside the enum instead of reading it as open", () => {
    const at = (state) =>
      decodeProposal(PROPOSAL_ID, WORDS(1, 1, 1, 1, 1, 1, state)).state;
    assert.equal(at(0), "open");
    assert.equal(at(1), "verified");
    assert.equal(at(2), "failed");
    assert.throws(() => at(9), /not a ProposalState/);
    assert.throws(() => at(255), /not a ProposalState/);
  });

  it("refuses short return data instead of reading zeros", () => {
    assert.throws(
      () => decodeProposal(PROPOSAL_ID, WORDS(1, 2)),
      /32-byte word/,
    );
  });
});

describe("single-word reads", () => {
  it("reads a uint and a weight", () => {
    assert.equal(decodeAmount(WORDS(12345)), "12345");
    assert.equal(decodeWeight(WORDS(9e18)), (9n * 10n ** 18n).toString());
    assert.throws(() => decodeAmount("0x1234"), /32-byte word/);
  });
});

describe("the vault address", () => {
  it("is accepted only as a full address", () => {
    assert.equal(isAddress(`0x${"11".repeat(20)}`), true);
    assert.equal(isAddress("0x1234"), false);
    assert.equal(isAddress(null), false);
    assert.equal(isAddress("nope"), false);
  });
});

describe("the struct order matches the compiled ABI", () => {
  it("Proposal comes back as minAmount, maxAmount, deadline, checkHash, reserved, escrowed, state", (t) => {
    const rel = "contracts/out/ProposalVault.sol/ProposalVault.json";
    const path = fileURLToPath(
      new URL(`../../../../../${rel}`, import.meta.url),
    );
    if (!existsSync(path)) {
      if (process.env.REQUIRE_CONTRACT_ARTIFACTS === "1") {
        assert.fail(`${rel} is missing but REQUIRE_CONTRACT_ARTIFACTS=1`);
      }
      t.skip(`artifact not built: ${rel}`);
      return;
    }
    const abi = JSON.parse(readFileSync(path, "utf8")).abi;
    const getter = abi.find(
      (e) => e.type === "function" && e.name === "proposals",
    );
    assert.ok(getter, "ProposalVault must expose a `proposals` getter");
    assert.deepEqual(
      getter.outputs.map((o) => o.name),
      [
        "minAmount",
        "maxAmount",
        "deadline",
        "checkHash",
        "reserved",
        "escrowed",
        "state",
      ],
      "the decoder above reads these positions; reorder them and it reads the wrong numbers",
    );
  });
});
