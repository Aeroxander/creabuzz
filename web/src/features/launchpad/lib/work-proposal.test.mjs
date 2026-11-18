import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";

import {
  askForShare,
  parseWorkProposal,
  proposalProblem,
  proposalStatus,
  shareAfter,
  workProposalDraft,
  workProposalTopic,
} from "./work-proposal.ts";

const DAO = "0xAbCdEf0000000000000000000000000000000001";
const input = {
  boardId: "board-1",
  chainId: 31337,
  dao: DAO,
  title: "Translate the docs to Spanish",
  body: "All twelve pages, kept in sync for three months.",
  name: "docs-es",
  askWhole: 5_000n,
  check: "All twelve pages are translated and merged",
};
const asEvent = (draft, pubkey = "a".repeat(64)) => ({
  id: "e".repeat(64),
  pubkey,
  created_at: 100,
  ...draft,
});

describe("work proposals", () => {
  it("are board posts tagged for one project, with the price and the check", () => {
    const draft = workProposalDraft(input);
    assert.equal(draft.kind, 45001);
    assert.deepEqual(draft.tags, [
      ["h", "board-1"],
      ["t", "work-proposal"],
      ["t", workProposalTopic(31337, DAO)],
      ["project", "docs-es"],
      ["ask", "5000"],
      ["check", "All twelve pages are translated and merged"],
    ]);
    assert.equal(
      workProposalTopic(31337, DAO),
      `work-proposal:31337:${DAO.toLowerCase()}`,
    );
  });

  it("read back as the project's suggestions, keyed as an approved project would be", () => {
    const parsed = parseWorkProposal(
      asEvent(workProposalDraft(input)),
      31337,
      DAO.toLowerCase(),
    );
    assert.equal(parsed.title, "Translate the docs to Spanish");
    assert.equal(parsed.askWhole, 5_000n);
    assert.equal(parsed.projectId, idWord("docs-es"));
    assert.equal(
      parsed.checkHash,
      hashText("All twelve pages are translated and merged"),
    );
    // For another project, or garbled, it is not one.
    assert.equal(
      parseWorkProposal(
        asEvent(workProposalDraft(input)),
        31337,
        `0x${"1".repeat(40)}`,
      ),
      null,
    );
    const garbled = workProposalDraft(input);
    garbled.tags = garbled.tags.map((t) =>
      t[0] === "ask" ? ["ask", "lots"] : t,
    );
    assert.equal(parseWorkProposal(asEvent(garbled), 31337, DAO), null);
  });

  it("refuse what cannot become a project, in plain words", () => {
    assert.match(proposalProblem({ ...input, name: "" }), /short name/);
    assert.match(
      proposalProblem({ ...input, name: "a".repeat(33) }),
      /32 letters/,
    );
    assert.match(proposalProblem({ ...input, check: "ok" }), /finished work/);
    assert.match(proposalProblem({ ...input, askWhole: 0n }), /at least one/);
    assert.equal(proposalProblem(input), null);
  });

  it("convert a percent ask to Shares against what exists now, and back", () => {
    // 5% of a project with 100,000 Shares: 5,264 more Shares hold 5% once added.
    const ask = askForShare(500, 100_000n);
    assert.equal(ask, 5_264n);
    assert.ok(shareAfter(ask, 100_000n) >= 500);
    assert.equal(shareAfter(5_000n, 95_000n), 500);
    assert.throws(() => askForShare(10_000, 1n));
  });

  it("are approved once a project with the same name and check exists", () => {
    const parsed = parseWorkProposal(
      asEvent(workProposalDraft(input)),
      31337,
      DAO,
    );
    assert.equal(proposalStatus(parsed, []), "suggested");
    assert.equal(
      proposalStatus(parsed, [
        {
          projectId: idWord("docs-es"),
          checkHash: hashText("All twelve pages are translated and merged"),
        },
      ]),
      "approved",
    );
    assert.equal(
      proposalStatus(parsed, [
        { projectId: idWord("docs-es"), checkHash: hashText("something else") },
      ]),
      "suggested",
    );
  });
});
