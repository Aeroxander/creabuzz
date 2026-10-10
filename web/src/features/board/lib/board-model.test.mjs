import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { arrange, buildBoard, filterPosts, sortPosts } from "./board-model.ts";

const ME = "m".repeat(64);
const ANN = "a".repeat(64);
const BOB = "b".repeat(64);
const DAO = `0x${"ab".repeat(20)}`;
const PID = `0x${"0f".repeat(32)}`;

let n = 0;
const id = () => `e${String(++n).padStart(3, "0")}`.padEnd(64, "0");
const post = (author, at, title = "T", extra = {}) => ({
  id: extra.id ?? id(),
  pubkey: author,
  kind: 45001,
  created_at: at,
  tags: [["h", "board"], ...(extra.tags ?? [])],
  content: `# ${title}\n\nbody`,
});
const comment = (author, at, root, parent = root, extra = {}) => ({
  id: extra.id ?? id(),
  pubkey: author,
  kind: 45003,
  created_at: at,
  tags: [
    ["h", "board"],
    ...(parent === root
      ? [["e", root, "", "reply"]]
      : [
          ["e", root, "", "root"],
          ["e", parent, "", "reply"],
        ]),
  ],
  content: "c",
});
const vote = (author, at, target, sign = "+") => ({
  id: id(),
  pubkey: author,
  kind: 45002,
  created_at: at,
  tags: [
    ["h", "board"],
    ["e", target],
  ],
  content: sign,
});
const del = (author, at, target) => ({
  id: id(),
  pubkey: author,
  kind: 5,
  created_at: at,
  tags: [
    ["h", "board"],
    ["e", target],
  ],
  content: "",
});

describe("buildBoard", () => {
  it("reads titles, bodies and topics", () => {
    const p = post(ANN, 10, "Hello", { tags: [["t", "ideas"]] });
    const { posts } = buildBoard([p], null);
    assert.equal(posts[0].title, "Hello");
    assert.equal(posts[0].body, "body");
    assert.deepEqual(posts[0].topics, ["ideas"]);
    assert.equal(posts[0].proposal, null);
  });

  it("scores a post by each person's latest vote and remembers the reader's", () => {
    const p = post(ANN, 10);
    const events = [
      p,
      vote(ANN, 11, p.id),
      vote(BOB, 12, p.id),
      vote(BOB, 13, p.id, "-"), // BOB changes their mind
      vote(ME, 14, p.id),
    ];
    const [out] = buildBoard(events, ME).posts;
    assert.equal(out.score, 1); // ANN +1, BOB -1, ME +1
    assert.equal(out.myVote, 1);
    assert.deepEqual(out.myVoteIds, [events[4].id]);
  });

  it("keeps every vote record the reader wrote, so taking the vote back can clear them all", () => {
    const p = post(ANN, 10);
    const first = vote(ME, 11, p.id, "+");
    const second = vote(ME, 12, p.id, "-");
    const [out] = buildBoard([p, first, second], ME).posts;
    assert.equal(out.myVote, -1);
    assert.deepEqual(out.myVoteIds, [second.id, first.id]);
    // Deleting only the newest would let the earlier one count again.
    assert.equal(
      buildBoard([p, first, second, del(ME, 13, second.id)], ME).posts[0].score,
      1,
    );
    assert.equal(
      buildBoard(
        [p, first, second, del(ME, 13, second.id), del(ME, 14, first.id)],
        ME,
      ).posts[0].score,
      0,
    );
  });

  it("breaks a tie between votes in the same second by id, not by arrival", () => {
    const p = post(ANN, 10);
    const a = { ...vote(BOB, 20, p.id, "+"), id: "1".repeat(64) };
    const b = { ...vote(BOB, 20, p.id, "-"), id: "2".repeat(64) };
    assert.equal(buildBoard([p, a, b], null).posts[0].score, -1);
    assert.equal(buildBoard([p, b, a], null).posts[0].score, -1);
  });

  it("ignores votes that are not + or -, or have no target", () => {
    const p = post(ANN, 10);
    const odd = { ...vote(BOB, 11, p.id), content: "++" };
    const none = { ...vote(BOB, 12, p.id), tags: [["h", "board"]] };
    assert.equal(buildBoard([p, odd, none], null).posts[0].score, 0);
  });

  it("counts comments, tracks last activity and orders comments oldest first", () => {
    const p = post(ANN, 10);
    const c2 = comment(BOB, 30, p.id);
    const c1 = comment(ANN, 20, p.id);
    const reply = comment(BOB, 40, p.id, c1.id);
    const board = buildBoard([p, c2, reply, c1], null);
    assert.equal(board.posts[0].commentCount, 3);
    assert.equal(board.posts[0].lastActivity, 40);
    const list = board.comments.get(p.id);
    assert.deepEqual(
      list.map((c) => c.id),
      [c1.id, c2.id, reply.id],
    );
    assert.equal(list[2].replyTo, c1.id);
    assert.equal(list[0].replyTo, null);
  });

  it("drops a comment on a post it does not have", () => {
    const p = post(ANN, 10);
    const board = buildBoard([p, comment(BOB, 20, "f".repeat(64))], null);
    assert.equal(board.posts[0].commentCount, 0);
    assert.equal(board.comments.size, 0);
  });

  it("reads a comment with a single unmarked reference as an answer to the post", () => {
    const p = post(ANN, 10);
    const c = {
      ...comment(BOB, 20, p.id),
      tags: [
        ["h", "board"],
        ["e", p.id],
      ],
    };
    assert.equal(buildBoard([p, c], null).posts[0].commentCount, 1);
  });

  it("honours a deletion only from the author of what is deleted", () => {
    const p = post(ANN, 10);
    const stranger = del(BOB, 11, p.id);
    assert.equal(buildBoard([p, stranger], null).posts.length, 1);
    const own = del(ANN, 12, p.id);
    assert.equal(buildBoard([p, stranger, own], null).posts.length, 0);
  });

  it("a deleted comment disappears, and an answer to it reads as an answer to the post", () => {
    const p = post(ANN, 10);
    const c = comment(BOB, 20, p.id);
    const re = comment(ANN, 30, p.id, c.id);
    const board = buildBoard([p, c, re, del(BOB, 31, c.id)], null);
    const list = board.comments.get(p.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].replyTo, null);
  });

  it("a deleted vote no longer counts", () => {
    const p = post(ANN, 10);
    const v = vote(BOB, 11, p.id);
    assert.equal(
      buildBoard([p, v, del(BOB, 12, v.id)], null).posts[0].score,
      0,
    );
  });

  it("reads the decision a proposal post names, and hides the link tags from topics", () => {
    const topic = `proposal:1:${DAO}:${PID}`;
    const p = post(ANN, 10, "Fund it", {
      tags: [
        ["t", "proposal"],
        ["t", topic],
        ["t", "budget"],
      ],
    });
    const [out] = buildBoard([p], null).posts;
    assert.deepEqual(out.proposal, { chainId: 1, dao: DAO, id: PID });
    assert.deepEqual(out.topics, ["budget"]);
  });
});

describe("sortPosts / filterPosts", () => {
  const board = () => {
    const a = post(ANN, 10, "old-busy");
    const b = post(BOB, 20, "new-quiet");
    const c = post(ANN, 15, "mid-loved");
    return {
      a,
      b,
      c,
      posts: buildBoard(
        [
          a,
          b,
          c,
          comment(BOB, 90, a.id),
          vote(ANN, 30, c.id),
          vote(BOB, 31, c.id),
        ],
        null,
      ).posts,
    };
  };
  it("active puts the most recent activity first, new the newest post, top the best score", () => {
    const { a, b, c, posts } = board();
    assert.deepEqual(
      sortPosts(posts, "active").map((p) => p.id),
      [a.id, b.id, c.id],
    );
    assert.deepEqual(
      sortPosts(posts, "new").map((p) => p.id),
      [b.id, c.id, a.id],
    );
    assert.deepEqual(
      sortPosts(posts, "top").map((p) => p.id),
      [c.id, b.id, a.id],
    );
  });
  it("puts posts with a better priority first, and orders each group by the sort asked for", () => {
    const a = post(ANN, 10, "settled-newest-activity");
    const b = post(BOB, 20, "live-old");
    const c = post(ANN, 30, "live-newer");
    const posts = buildBoard(
      [
        a,
        b,
        c,
        comment(BOB, 99, a.id),
        vote(ANN, 40, a.id),
        vote(BOB, 41, a.id),
      ],
      null,
    ).posts;
    const priority = new Map([
      [b.id, 0],
      [c.id, 0],
    ]);
    // Without a priority, the most active post leads; with it, the live ones lead whatever their votes or activity.
    assert.equal(sortPosts(posts, "active")[0].id, a.id);
    assert.deepEqual(
      sortPosts(posts, "active", priority).map((p) => p.id),
      [c.id, b.id, a.id],
    );
    // Votes never decide a proposal's place: the best-voted post is still last.
    assert.deepEqual(
      sortPosts(posts, "new", priority).map((p) => p.id),
      [c.id, b.id, a.id],
    );
  });

  it("never lets votes rank a proposal post, however many it has", () => {
    const topic = `proposal:1:${DAO}:${PID}`;
    const loved = post(ANN, 10, "loved proposal", {
      tags: [
        ["t", "proposal"],
        ["t", topic],
      ],
    });
    const newer = post(BOB, 20, "newer proposal", {
      tags: [
        ["t", "proposal"],
        ["t", topic],
      ],
    });
    const plain = post(ANN, 5, "plain");
    const events = [
      loved,
      newer,
      plain,
      vote(ANN, 30, loved.id),
      vote(BOB, 31, loved.id),
      vote(ME, 32, loved.id),
      vote(BOB, 33, plain.id),
    ];
    const posts = buildBoard(events, null).posts;
    assert.equal(posts.find((p) => p.id === loved.id).score, 3);
    // A plain post with one vote beats a proposal with three, and proposals fall back to newest first.
    assert.deepEqual(
      sortPosts(posts, "top").map((p) => p.id),
      [plain.id, newer.id, loved.id],
    );
  });

  it("filters to proposal posts", () => {
    const topic = `proposal:1:${DAO}:${PID}`;
    const p = post(ANN, 10, "P", {
      tags: [
        ["t", "proposal"],
        ["t", topic],
      ],
    });
    const q = post(ANN, 11, "Q");
    const posts = buildBoard([p, q], null).posts;
    assert.deepEqual(
      filterPosts(posts, "proposals").map((x) => x.id),
      [p.id],
    );
    assert.equal(filterPosts(posts, "all").length, 2);
  });
});

describe("arrange", () => {
  const base = () => {
    const a = post(ANN, 10, "a");
    const b = post(BOB, 20, "b");
    return { a, b, events: [a, b] };
  };

  it("arranges afresh when nothing is frozen", () => {
    const { a, b, events } = base();
    const out = arrange({
      posts: buildBoard(events, ME).posts,
      sort: "new",
      frozen: null,
      me: ME,
    });
    assert.deepEqual(
      out.rows.map((p) => p.id),
      [b.id, a.id],
    );
    assert.deepEqual(out.order, [b.id, a.id]);
    assert.equal(out.fresh, 0);
    assert.equal(out.reordered, false);
  });

  it("holds the list still when someone replies, and says it would move", () => {
    const { a, b, events } = base();
    const frozen = [b.id, a.id];
    const out = arrange({
      posts: buildBoard([...events, comment(BOB, 99, a.id)], ME).posts,
      sort: "active",
      frozen,
      me: ME,
    });
    assert.deepEqual(
      out.rows.map((p) => p.id),
      [b.id, a.id],
    );
    assert.equal(out.rows[1].commentCount, 1); // counts still update live
    assert.equal(out.reordered, true);
    assert.equal(out.fresh, 0);
  });

  it("holds other people's new posts back and counts them, but shows the reader's own at once", () => {
    const { a, b, events } = base();
    const theirs = post(ANN, 50, "theirs");
    const mine = post(ME, 60, "mine");
    const out = arrange({
      posts: buildBoard([...events, theirs, mine], ME).posts,
      sort: "new",
      frozen: [b.id, a.id],
      me: ME,
    });
    assert.deepEqual(
      out.rows.map((p) => p.id),
      [mine.id, b.id, a.id],
    );
    assert.equal(out.fresh, 1);
  });

  it("keeps priority in the arrangement, and holds it still like any other order", () => {
    const { a, b, events } = base();
    const posts = buildBoard(events, ME).posts;
    const first = arrange({
      posts,
      sort: "active",
      frozen: null,
      me: ME,
      priority: new Map([[a.id, 0]]),
    });
    assert.deepEqual(
      first.rows.map((p) => p.id),
      [a.id, b.id],
    );
    // The decision behind b becomes live later: the list does not move, and says it would.
    const later = arrange({
      posts,
      sort: "active",
      frozen: first.order,
      me: ME,
      priority: new Map([
        [a.id, 1],
        [b.id, 0],
      ]),
    });
    assert.deepEqual(
      later.rows.map((p) => p.id),
      [a.id, b.id],
    );
    assert.equal(later.reordered, true);
  });

  it("drops a post that was deleted from a frozen list", () => {
    const { a, b, events } = base();
    const out = arrange({
      posts: buildBoard([...events, del(BOB, 30, b.id)], ME).posts,
      sort: "new",
      frozen: [b.id, a.id],
      me: ME,
    });
    assert.deepEqual(
      out.rows.map((p) => p.id),
      [a.id],
    );
  });
});
