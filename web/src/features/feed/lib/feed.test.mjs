/**
 * The feed's pure core under `node --test`: event shapes other Nostr clients
 * can read, vote tallying with weights, ranking, trust weights and lists.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPost,
  buildReply,
  buildVote,
  displayText,
  extractTopics,
  launchCoordinate,
  parseLaunchCoordinate,
  parseNote,
} from "./feed-events.ts";
import {
  coordinatesFromLegacyKeys,
  followedLaunches,
  followedPeople,
  latestList,
  withLaunch,
  withMigratedLaunches,
  withPerson,
} from "./lists.ts";
import { hotScore, sortByMode, tallyVotes } from "./ranking.ts";
import {
  acceptedContributions,
  MAX_WEIGHT,
  NEWCOMER_WEIGHT,
  orgGraphFromEvents,
  voteWeights,
} from "./trust-weight.ts";

const hex = (c) => c.repeat(64);
const ALICE = hex("a");
const BOB = hex("b");
const CAROL = hex("c");
const ADMIN = hex("d");
const LAUNCH = { pubkey: ALICE, id: "nebula" };

let seq = 0;
function ev(fields) {
  seq += 1;
  return {
    id: fields.id ?? seq.toString(16).padStart(64, "0"),
    pubkey: fields.pubkey ?? ALICE,
    kind: fields.kind ?? 1,
    created_at: fields.created_at ?? 1_700_000_000 + seq,
    tags: fields.tags ?? [],
    content: fields.content ?? "",
  };
}

describe("feed events", () => {
  it("a launch post carries the coordinate, topics and an naddr link", () => {
    const post = buildPost({
      text: "Backing #DeFi #agents today",
      launch: LAUNCH,
    });
    assert.equal(post.kind, 1);
    assert.deepEqual(
      post.tags.filter((t) => t[0] === "t").map((t) => t[1]),
      ["defi", "agents"],
    );
    assert.ok(
      post.tags.some((t) => t[0] === "a" && t[1] === `37001:${ALICE}:nebula`),
    );
    assert.match(post.content, /nostr:naddr1[0-9a-z]+$/);
    assert.equal(displayText(post.content), "Backing #DeFi #agents today");
  });

  it("empty and oversized posts are refused", () => {
    assert.throws(() => buildPost({ text: "   " }), /Write something/);
    assert.throws(() => buildPost({ text: "x".repeat(2001) }), /under 2000/);
  });

  it("replies use NIP-10 markers and keep the launch coordinate", () => {
    const root = ev({
      tags: [["a", launchCoordinate(LAUNCH)]],
      content: "root",
    });
    const parent = ev({ pubkey: BOB, tags: [["e", root.id, "", "root"]] });
    const reply = buildReply({ text: "agreed", root, parent });
    assert.deepEqual(reply.tags.slice(0, 2), [
      ["e", root.id, "", "root"],
      ["e", parent.id, "", "reply"],
    ]);
    assert.ok(
      reply.tags.some((t) => t[0] === "a" && t[1] === launchCoordinate(LAUNCH)),
    );
    const parsed = parseNote({
      ...ev({}),
      ...reply,
      id: hex("9"),
      pubkey: CAROL,
      created_at: 1,
    });
    assert.equal(parsed.rootId, root.id);
    assert.equal(parsed.replyToId, parent.id);
  });

  it("parses legacy positional e tags and agent authorship", () => {
    const root = hex("1");
    const reply = hex("2");
    const note = parseNote(
      ev({
        tags: [
          ["e", root],
          ["e", reply],
          ["auth", "x"],
        ],
      }),
    );
    assert.equal(note.rootId, root);
    assert.equal(note.replyToId, reply);
    assert.equal(note.byAgent, true);
    assert.equal(parseNote(ev({ kind: 7 })), null);
  });

  it("votes name the event id the relay requires, plus the coordinate", () => {
    const record = ev({ kind: 37001, pubkey: ALICE });
    const vote = buildVote({ target: record, direction: "+", launch: LAUNCH });
    assert.deepEqual(vote.tags, [
      ["e", record.id],
      ["p", ALICE],
      ["k", "37001"],
      ["a", `37001:${ALICE}:nebula`],
    ]);
    assert.equal(vote.content, "+");
  });

  it("coordinates round-trip and malformed ones are refused", () => {
    assert.deepEqual(parseLaunchCoordinate(launchCoordinate(LAUNCH)), LAUNCH);
    assert.equal(parseLaunchCoordinate("1:abc:x"), null);
    assert.equal(parseLaunchCoordinate(`37001:${ALICE}:`), null);
    assert.deepEqual(extractTopics("#a #bb #CC"), ["bb", "cc"]);
  });
});

describe("tally and ranking", () => {
  it("the latest vote per voter wins and emoji carry no vote", () => {
    const target = hex("e");
    const reactions = [
      ev({
        kind: 7,
        pubkey: BOB,
        created_at: 10,
        tags: [["e", target]],
        content: "+",
      }),
      ev({
        kind: 7,
        pubkey: BOB,
        created_at: 20,
        tags: [["e", target]],
        content: "-",
      }),
      ev({
        kind: 7,
        pubkey: CAROL,
        created_at: 15,
        tags: [["e", target]],
        content: "+",
      }),
      ev({
        kind: 7,
        pubkey: ALICE,
        created_at: 15,
        tags: [["e", target]],
        content: "🔥",
      }),
    ];
    const tally = tallyVotes(reactions, () => 1, BOB).get(target);
    assert.deepEqual(tally, { up: 1, down: 1, score: 0, mine: "-" });
  });

  it("launch votes tally by coordinate across record versions", () => {
    const coord = launchCoordinate(LAUNCH);
    const reactions = [
      ev({
        kind: 7,
        pubkey: BOB,
        tags: [
          ["e", hex("1")],
          ["a", coord],
        ],
        content: "+",
      }),
      ev({
        kind: 7,
        pubkey: CAROL,
        tags: [
          ["e", hex("2")],
          ["a", coord],
        ],
        content: "+",
      }),
    ];
    assert.equal(tallyVotes(reactions, () => 1).get(coord).up, 2);
  });

  it("weights decide: many newcomers do not beat one trusted voter", () => {
    const target = hex("e");
    const swarm = Array.from({ length: 9 }, (_, i) =>
      ev({
        kind: 7,
        pubkey: (i + 1).toString(16).padStart(64, "0"),
        tags: [["e", target]],
        content: "-",
      }),
    );
    const trusted = ev({
      kind: 7,
      pubkey: ADMIN,
      tags: [["e", target]],
      content: "+",
    });
    const weight = (pk) => (pk === ADMIN ? 2 : 0.2);
    const tally = tallyVotes([...swarm, trusted], weight).get(target);
    assert.ok(Math.abs(tally.score - (2 - 9 * 0.2)) < 1e-9);
    assert.ok(tally.score > 0);
  });

  it("hot favours newer items at equal score and higher score at equal age", () => {
    assert.ok(hotScore(10, 1_800_000_000) > hotScore(10, 1_700_000_000));
    assert.ok(hotScore(100, 1_750_000_000) > hotScore(10, 1_750_000_000));
    assert.ok(hotScore(-10, 1_750_000_000) < hotScore(0, 1_750_000_000));
    const items = [
      { s: 1, t: 1 },
      { s: 5, t: 0 },
      { s: 0, t: 2 },
    ];
    assert.deepEqual(
      sortByMode(
        items,
        "new",
        (i) => i.s,
        (i) => i.t,
      ).map((i) => i.t),
      [2, 1, 0],
    );
    assert.deepEqual(
      sortByMode(
        items,
        "top",
        (i) => i.s,
        (i) => i.t,
      ).map((i) => i.s),
      [5, 1, 0],
    );
  });
});

describe("trust weights", () => {
  const root = ev({
    kind: 37010,
    pubkey: ADMIN,
    tags: [["d", "root"]],
    content: JSON.stringify({
      name: "Org",
      holders: [ADMIN],
      agentSeats: [],
      scope: {},
    }),
  });
  const seat = ev({
    kind: 37010,
    pubkey: ADMIN,
    tags: [["d", "eng"]],
    content: JSON.stringify({
      name: "Eng",
      parent: "root",
      holders: [BOB],
      agentSeats: [CAROL],
      scope: {},
    }),
  });
  const contribution = (author, d, status, at) =>
    ev({
      kind: 37013,
      pubkey: author,
      created_at: at,
      tags: [["d", d]],
      content: JSON.stringify({ reviewStatus: status, action: "work" }),
    });

  it("admins come from root nodes; seated humans hold authority, agent seats do not", () => {
    const graph = orgGraphFromEvents([root, seat]);
    assert.deepEqual(graph.admins, [ADMIN]);
    const weight = voteWeights(graph, []);
    assert.equal(weight(ADMIN), MAX_WEIGHT);
    assert.equal(weight(BOB), MAX_WEIGHT);
    assert.equal(
      weight(CAROL),
      NEWCOMER_WEIGHT,
      "an agent seat confers nothing",
    );
    assert.equal(weight(ALICE), NEWCOMER_WEIGHT);
  });

  it("only an authority holder's acceptance counts, never self-review", () => {
    const graph = orgGraphFromEvents([root, seat]);
    const records = [
      contribution(ALICE, "w1", "pending", 100),
      contribution(ALICE, "w1", "accepted", 101), // self-review: ignored
      contribution(CAROL, "w1", "accepted", 102), // agent seat: ignored
      contribution(ALICE, "w2", "pending", 100),
      contribution(BOB, "w2", "accepted", 103), // seated human: counts
      contribution(ALICE, "w3", "pending", 100),
      contribution(ADMIN, "w3", "accepted", 104), // admin: counts
    ];
    assert.equal(acceptedContributions(graph, records).get(ALICE), 2);
    // An authority holder accepting their own record is still self-review.
    const selfAccepted = [
      contribution(BOB, "w9", "pending", 100),
      contribution(BOB, "w9", "accepted", 101),
    ];
    assert.equal(
      acceptedContributions(graph, selfAccepted).get(BOB),
      undefined,
    );
    assert.equal(voteWeights(graph, records)(ALICE), 1.25);
  });

  it("with no org graph everyone is a newcomer", () => {
    const weight = voteWeights(orgGraphFromEvents([]), []);
    assert.equal(weight(ADMIN), NEWCOMER_WEIGHT);
  });
});

describe("follow lists", () => {
  it("toggling keeps unknown tags and the latest list wins", () => {
    const older = ev({
      kind: 10003,
      pubkey: ALICE,
      created_at: 1,
      tags: [["a", "x"]],
    });
    const newer = ev({
      kind: 10003,
      pubkey: ALICE,
      created_at: 2,
      tags: [
        ["e", hex("f")],
        ["a", "30023:x:y"],
      ],
    });
    const list = latestList([older, newer], 10003, ALICE);
    assert.equal(list, newer);
    const next = withLaunch(list, launchCoordinate(LAUNCH), true);
    assert.deepEqual(next.tags, [
      ["e", hex("f")],
      ["a", "30023:x:y"],
      ["a", launchCoordinate(LAUNCH)],
    ]);
    const removed = withLaunch(
      { ...newer, tags: next.tags },
      launchCoordinate(LAUNCH),
      false,
    );
    assert.equal(
      followedLaunches({ ...newer, tags: removed.tags }).has(
        launchCoordinate(LAUNCH),
      ),
      false,
    );
  });

  it("people follows keep relay hints on other entries", () => {
    const list = ev({
      kind: 3,
      pubkey: ALICE,
      tags: [["p", BOB, "wss://r"]],
      content: "{}",
    });
    const next = withPerson(list, CAROL, true);
    assert.deepEqual(next.tags, [
      ["p", BOB, "wss://r"],
      ["p", CAROL],
    ]);
    assert.equal(next.content, "{}");
    assert.deepEqual(
      [...followedPeople({ ...list, tags: next.tags })],
      [BOB, CAROL],
    );
  });

  it("migrates the old browser-only follows once", () => {
    const coords = coordinatesFromLegacyKeys([
      `${ALICE}:nebula`,
      "junk",
      `${BOB}:`,
    ]);
    assert.deepEqual(coords, [`37001:${ALICE}:nebula`]);
    const migrated = withMigratedLaunches(null, coords);
    assert.deepEqual(migrated.tags, [["a", `37001:${ALICE}:nebula`]]);
    assert.equal(
      withMigratedLaunches(
        { ...ev({ kind: 10003 }), tags: migrated.tags },
        coords,
      ),
      null,
    );
  });
});
