import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupProposalThreads } from "./proposal-threads.ts";

const DAO = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const P1 = `0x${"01".repeat(32)}`;
const P2 = `0x${"02".repeat(32)}`;

let n = 0;
const post = (at, tags, title = "T") => ({
  id: `post${++n}`.padEnd(64, "0"),
  pubkey: "a".repeat(64),
  kind: 45001,
  created_at: at,
  tags: [["h", "b1"], ...tags],
  content: `# ${title}`,
});
const about = (chain, dao, id) => [
  ["t", "proposal"],
  ["t", `proposal:${chain}:${dao}:${id}`],
];
const found = (post, boardId = "b1", boardName = "supporters") => ({
  boardId,
  boardName,
  post,
});

describe("groupProposalThreads", () => {
  it("groups the posts about each decision of the DAO, newest first", () => {
    const old = post(10, about(31337, DAO, P1), "old");
    const fresh = post(30, about(31337, DAO, P1), "fresh");
    const other = post(20, about(31337, DAO, P2), "second decision");
    const out = groupProposalThreads(
      [found(old), found(fresh, "b2", "founders"), found(other)],
      31337,
      DAO,
    );
    assert.deepEqual(
      out.get(P1).map((t) => [t.title, t.boardName]),
      [
        ["fresh", "founders"],
        ["old", "supporters"],
      ],
    );
    assert.deepEqual(
      out.get(P2).map((t) => t.title),
      ["second decision"],
    );
  });

  it("ignores posts about another DAO or chain, posts with no valid decision, and plain posts", () => {
    const out = groupProposalThreads(
      [
        found(post(1, about(31337, OTHER, P1))),
        found(post(2, about(1, DAO, P1))),
        found(post(3, [["t", "proposal"]])),
        found(post(4, [["t", "proposal:junk"]])),
        found(post(5, [])),
      ],
      31337,
      DAO,
    );
    assert.equal(out.size, 0);
  });

  it("ignores a post that names two decisions, and counts a post once even if two reads returned it", () => {
    const two = post(1, [
      ...about(31337, DAO, P1),
      ["t", `proposal:31337:${DAO}:${P2}`],
    ]);
    assert.equal(groupProposalThreads([found(two)], 31337, DAO).size, 0);
    const once = post(2, about(31337, DAO, P1));
    assert.equal(
      groupProposalThreads([found(once), found(once)], 31337, DAO).get(P1)
        .length,
      1,
    );
  });

  it("matches the DAO whatever the case it is given in", () => {
    const p = post(1, about(31337, DAO, P1));
    assert.equal(
      groupProposalThreads(
        [found(p)],
        31337,
        DAO.toUpperCase().replace("0X", "0x"),
      ).get(P1).length,
      1,
    );
  });
});
