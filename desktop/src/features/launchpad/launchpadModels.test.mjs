import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunchesFromEvents,
  launchCoordinate,
  parseLaunchBidEvent,
  parseLaunchProposalEvent,
  parseLaunchReceiptEvent,
  parseLaunchRecordEvent,
  parseLaunchUpdateEvent,
} from "./launchpadModels.ts";

const FOUNDER = "a".repeat(64);
const INVESTOR = "b".repeat(64);

function recordEvent(overrides = {}) {
  return {
    id: "record-1",
    kind: 37001,
    pubkey: FOUNDER,
    created_at: 100,
    content: JSON.stringify({ pitch: "To the stars.", stage: "live" }),
    tags: [
      ["d", "nebula"],
      ["name", "Nebula DAO"],
    ],
    sig: "sig",
    ...overrides,
  };
}

test("parseLaunchRecordEvent parses a valid record", () => {
  const record = parseLaunchRecordEvent(recordEvent());
  assert.ok(record);
  assert.equal(record.id, "nebula");
  assert.equal(record.name, "Nebula DAO");
  assert.equal(record.stage, "live");
});

test("parseLaunchRecordEvent rejects non-record kinds", () => {
  assert.equal(parseLaunchRecordEvent(recordEvent({ kind: 47002 })), null);
});

test("parseLaunchRecordEvent rejects missing name", () => {
  assert.equal(
    parseLaunchRecordEvent(recordEvent({ tags: [["d", "nebula"]] })),
    null,
  );
});

test("parseLaunchRecordEvent defaults unknown stage to draft", () => {
  const record = parseLaunchRecordEvent(
    recordEvent({ content: JSON.stringify({ stage: "moon" }) }),
  );
  assert.ok(record);
  assert.equal(record.stage, "draft");
});

test("parseLaunchRecordEvent reads team, chain, and addresses", () => {
  const record = parseLaunchRecordEvent(
    recordEvent({
      tags: [
        ["d", "nebula"],
        ["name", "Nebula DAO"],
        ["chain", "11155111"],
        ["auction", "0x1234"],
        ["team", INVESTOR, "founder"],
        ["buzz-channel", "11111111-1111-1111-1111-111111111111"],
      ],
    }),
  );
  assert.ok(record);
  assert.equal(record.chainId, "11155111");
  assert.equal(record.auction, "0x1234");
  assert.deepEqual(record.team, [{ pubkey: INVESTOR, role: "founder" }]);
  assert.deepEqual(record.channels, ["11111111-1111-1111-1111-111111111111"]);
});

test("parseLaunchBidEvent parses a bid mirror", () => {
  const bid = parseLaunchBidEvent({
    id: "bid-1",
    kind: 47002,
    pubkey: INVESTOR,
    created_at: 200,
    content: JSON.stringify({ budget: "100", maxPrice: "2", tx: "0xabc" }),
    tags: [
      ["a", launchCoordinate(FOUNDER, "nebula")],
      ["m", "bucket-0"],
    ],
    sig: "sig",
  });
  assert.ok(bid);
  assert.equal(bid.launchId, "nebula");
  assert.equal(bid.bucket, "bucket-0");
  assert.equal(bid.budget, "100");
});

test("parseLaunchBidEvent rejects a coordinate of the wrong kind", () => {
  const bid = parseLaunchBidEvent({
    id: "bid-1",
    kind: 47002,
    pubkey: INVESTOR,
    created_at: 200,
    content: "{}",
    tags: [["a", `30621:${FOUNDER}:proj`]],
    sig: "sig",
  });
  // 30621 coordinates are not launch addresses, so the mirror is dropped.
  assert.equal(bid, null);
});

test("parseLaunchUpdateEvent parses founder updates", () => {
  const update = parseLaunchUpdateEvent({
    id: "u-1",
    kind: 47003,
    pubkey: FOUNDER,
    created_at: 300,
    content: JSON.stringify({ title: "Ship it", body: "We shipped." }),
    tags: [["a", launchCoordinate(FOUNDER, "nebula")]],
    sig: "sig",
  });
  assert.ok(update);
  assert.equal(update.title, "Ship it");
});

test("parseLaunchProposalEvent parses futarchy-budget proposals", () => {
  const proposal = parseLaunchProposalEvent({
    id: "p-1",
    kind: 47004,
    pubkey: FOUNDER,
    created_at: 400,
    content: JSON.stringify({ kind: "futarchy-budget", title: "Fund team" }),
    tags: [["a", launchCoordinate(FOUNDER, "nebula")]],
    sig: "sig",
  });
  assert.ok(proposal);
  assert.equal(proposal.kind, "futarchy-budget");
  assert.equal(proposal.state, "open");
  assert.equal(proposal.grant, null);
  assert.equal(proposal.onchain, null);
  assert.equal(proposal.intent, null);
});

test("parseLaunchProposalEvent reads the S0 onchain binding, grant, and intent", () => {
  const nonce = `0x${"11".repeat(32)}`;
  const proposal = parseLaunchProposalEvent({
    id: "p-2",
    kind: 47004,
    pubkey: FOUNDER,
    created_at: 401,
    content: JSON.stringify({
      kind: "plain",
      title: "Raise quorum",
      proposalId: "42",
      grant: "grant-1",
      onchain: { chain: "11155111", dao: `0x${"ab".repeat(20)}` },
      intent: {
        op: 0,
        to: `0x${"cd".repeat(20)}`,
        value: "0",
        data: "0x123456",
        nonce,
      },
    }),
    tags: [["a", launchCoordinate(FOUNDER, "nebula")]],
    sig: "sig",
  });
  assert.ok(proposal);
  assert.equal(proposal.proposalId, "42");
  assert.equal(proposal.grant, "grant-1");
  assert.deepEqual(proposal.onchain, {
    chain: "11155111",
    dao: `0x${"ab".repeat(20)}`,
  });
  assert.deepEqual(proposal.intent, {
    op: 0,
    to: `0x${"cd".repeat(20)}`,
    value: "0",
    data: "0x123456",
    nonce,
  });
});

test("parseLaunchProposalEvent reads proposalId from the onchain binding too", () => {
  const proposal = parseLaunchProposalEvent({
    id: "p-3",
    kind: 47004,
    pubkey: FOUNDER,
    created_at: 402,
    content: JSON.stringify({
      kind: "plain",
      title: "Bound",
      onchain: { chain: "1", dao: `0x${"ab".repeat(20)}`, proposalId: "7" },
    }),
    tags: [["a", launchCoordinate(FOUNDER, "nebula")]],
    sig: "sig",
  });
  assert.ok(proposal);
  assert.equal(proposal.proposalId, "7");
});

test("parseLaunchReceiptEvent requires a tx tag", () => {
  assert.equal(
    parseLaunchReceiptEvent({
      id: "r-1",
      kind: 47005,
      pubkey: FOUNDER,
      created_at: 500,
      content: "{}",
      tags: [["a", launchCoordinate(FOUNDER, "nebula")]],
      sig: "sig",
    }),
    null,
  );
});

test("parseLaunchReceiptEvent reads the §5 governance linkage tags", () => {
  const receipt = parseLaunchReceiptEvent({
    id: "r-2",
    kind: 47005,
    pubkey: FOUNDER,
    created_at: 501,
    content: JSON.stringify({ table: "vote" }),
    tags: [
      ["a", launchCoordinate(FOUNDER, "nebula")],
      ["kind", "vote"],
      ["tx", "0xabc"],
      ["proposal", "p-1"],
      ["onchain", "42"],
      ["vote", "for"],
      ["grant", "grant-1"],
    ],
    sig: "sig",
  });
  assert.ok(receipt);
  assert.equal(receipt.table, "vote");
  assert.equal(receipt.tx, "0xabc");
  assert.equal(receipt.proposal, "p-1");
  assert.equal(receipt.onchain, "42");
  assert.equal(receipt.vote, "for");
  assert.equal(receipt.grant, "grant-1");
});

test("buildLaunchesFromEvents reduces heads and attaches mirrors", () => {
  const old = recordEvent({ id: "old", created_at: 50 });
  const head = recordEvent({ id: "head", created_at: 150 });
  const coord = launchCoordinate(FOUNDER, "nebula");
  const launches = buildLaunchesFromEvents([
    old,
    head,
    {
      id: "bid-1",
      kind: 47002,
      pubkey: INVESTOR,
      created_at: 200,
      content: JSON.stringify({ budget: "5" }),
      tags: [
        ["a", coord],
        ["m", "bucket-0"],
      ],
      sig: "sig",
    },
    {
      id: "u-1",
      kind: 47003,
      pubkey: FOUNDER,
      created_at: 250,
      content: JSON.stringify({ title: "Hi", body: "Hello." }),
      tags: [["a", coord]],
      sig: "sig",
    },
  ]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].record.eventId, "head");
  assert.equal(launches[0].bids.length, 1);
  assert.equal(launches[0].updates.length, 1);
});

test("buildLaunchesFromEvents drops tombstoned launches", () => {
  const coord = launchCoordinate(FOUNDER, "nebula");
  const launches = buildLaunchesFromEvents([recordEvent()], new Set([coord]));
  assert.equal(launches.length, 0);
});

test("removing the tombstone guard resurrects the launch", () => {
  // Guard falsifiability: the tombstone set is the only thing hiding this
  // launch. Same input without the set must produce the card.
  const launches = buildLaunchesFromEvents([recordEvent()]);
  assert.equal(launches.length, 1);
});
