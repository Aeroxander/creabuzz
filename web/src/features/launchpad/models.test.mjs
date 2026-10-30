import assert from "node:assert/strict";
import test from "node:test";

import {
  launchRemovals,
  removedLaunchIds,
  LAUNCH_DEFAULTS,
  buildLaunches,
  hasFounderCommitments,
  launchCoordinate,
  parseLaunchProposal,
  parseScoreRoot,
} from "./models.ts";
import { hasBlockingIssue, validateLaunchParams } from "./lib/launch-params.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function record(pubkey, slug, createdAt = 100, extra = {}) {
  return {
    id: `record-${pubkey.slice(0, 4)}-${slug}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 37001,
    tags: [
      ["d", slug],
      ["name", slug],
    ],
    content: JSON.stringify({ pitch: "pitch", stage: "live", ...extra }),
    sig: "sig",
  };
}

function mirror(kind, pubkey, author, slug, createdAt = 110, tags = []) {
  return {
    id: `mirror-${kind}-${pubkey.slice(0, 4)}-${slug}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind,
    tags: [["a", launchCoordinate(author, slug)], ...tags],
    content: JSON.stringify({ title: `t-${slug}`, budget: "1" }),
    sig: "sig",
  };
}

test("a record says what it is built on and its remix terms; the link is not a linked project (N11)", () => {
  const remix = record(BOB, "fork", 100, {
    builtOn: { author: ALICE, id: "nebula" },
    remixTerms: { invited: false, asks: "" },
  });
  remix.tags.push(["a", `37001:${ALICE}:nebula`, "", "built-on"]);
  remix.tags.push(["a", `30621:${ALICE}:repo`]);
  const [launch] = buildLaunches([remix]);
  assert.deepEqual(launch.record.builtOn, { author: ALICE, id: "nebula" });
  assert.deepEqual(launch.record.remixTerms, {
    invited: false,
    asks: "",
    offers: [],
  });
  assert.deepEqual(launch.record.projects, [`30621:${ALICE}:repo`]);
  const plain = buildLaunches([record(ALICE, "nebula")])[0];
  assert.equal(plain.record.builtOn, null);
  assert.equal(plain.record.remixTerms, null);
});

test("the newest record per author and slug wins", () => {
  const launches = buildLaunches([
    record(ALICE, "nebula", 100),
    record(ALICE, "nebula", 200, { pitch: "newer pitch" }),
    record(ALICE, "orion", 150),
  ]);
  assert.equal(launches.length, 2);
  const nebula = launches.find((l) => l.record.id === "nebula");
  assert.equal(nebula?.record.pitch, "newer pitch");
});

test("two founders may use the same slug without sharing mirrors", () => {
  // The identity is `37001:<author>:<slug>`; keying on the slug alone gave each
  // founder the other's bids and updates.
  const launches = buildLaunches([
    record(ALICE, "nebula"),
    record(BOB, "nebula"),
    mirror(47002, "c".repeat(64), ALICE, "nebula", 120, [["m", "bucket-1"]]),
    mirror(47003, "d".repeat(64), BOB, "nebula", 130),
  ]);
  assert.equal(launches.length, 2);
  const alice = launches.find((l) => l.record.author === ALICE);
  const bob = launches.find((l) => l.record.author === BOB);
  assert.equal(alice?.bids.length, 1);
  assert.equal(alice?.updates.length, 0);
  assert.equal(bob?.bids.length, 0);
  assert.equal(bob?.updates.length, 1);
});

test("a mirror for an unknown launch is dropped", () => {
  const launches = buildLaunches([
    record(ALICE, "nebula"),
    mirror(47002, "c".repeat(64), BOB, "gone", 120, [["m", "b"]]),
  ]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].bids.length, 0);
});

test("a tombstoned coordinate hides only that author's launch", () => {
  const launches = buildLaunches(
    [record(ALICE, "nebula"), record(BOB, "nebula")],
    new Set([launchCoordinate(ALICE, "nebula")]),
  );
  assert.deepEqual(
    launches.map((l) => l.record.author),
    [BOB],
  );
});

test("mirrors are ordered newest-first for updates and oldest-first for receipts", () => {
  const launches = buildLaunches([
    record(ALICE, "nebula"),
    mirror(47003, "c".repeat(64), ALICE, "nebula", 120),
    mirror(47003, "d".repeat(64), ALICE, "nebula", 140),
    mirror(47005, "e".repeat(64), ALICE, "nebula", 130, [["tx", "0x1"]]),
    mirror(47005, "f".repeat(64), ALICE, "nebula", 110, [["tx", "0x2"]]),
  ]);
  const launch = launches[0];
  assert.deepEqual(
    launch.updates.map((u) => u.createdAt),
    [140, 120],
  );
  assert.deepEqual(
    launch.receipts.map((r) => r.createdAt),
    [110, 130],
  );
});

test("a mirror whose coordinate is malformed is ignored", () => {
  const bad = {
    id: "bad",
    pubkey: "c".repeat(64),
    created_at: 120,
    kind: 47002,
    tags: [["a", `47002:${ALICE}:nebula`]],
    content: JSON.stringify({ budget: "1" }),
    sig: "sig",
  };
  const launches = buildLaunches([record(ALICE, "nebula"), bad]);
  assert.equal(launches[0].bids.length, 0);
});

test("the defaults a new launch starts from are deployable", () => {
  // They were not: floor 1e6 is below the contract's MIN_FLOOR_PRICE and 100 does
  // not divide it, so the auction constructor would have reverted after the
  // founder had written the terms.
  const issues = validateLaunchParams({
    supply: BigInt(LAUNCH_DEFAULTS.supply) * 10n ** 18n,
    floorPrice: BigInt(LAUNCH_DEFAULTS.floorPrice),
    tickSpacing: BigInt(LAUNCH_DEFAULTS.tickSpacing),
    requiredCurrencyRaised: BigInt(LAUNCH_DEFAULTS.requiredRaised),
    // Schedule fields are not part of the form; the price grid is what shipped
    // broken, so that is what this pins.
    startBlock: 0n,
    endBlock: 0n,
    claimBlock: 0n,
    steps: [],
  }).filter(
    (issue) =>
      issue.field !== "steps" &&
      issue.field !== "endBlock" &&
      issue.field !== "claimBlock",
  );
  assert.deepEqual(issues, []);
  assert.equal(hasBlockingIssue(issues), false);
});

test("a record round-trips the monthly budget", () => {
  const KEY = "a".repeat(64);
  const withBudget = buildLaunches([
    record(KEY, "nebula", 100, { budget: "5000000000" }),
  ])[0];
  assert.equal(withBudget.record.budget, "5000000000");
  // Absent budget stays null — no fabricated figure.
  const bare = buildLaunches([record(KEY, "other", 101)])[0];
  assert.equal(bare.record.budget, null);
});

test("founder commitments round-trip and gate the live stage", () => {
  const KEY = "a".repeat(64);
  const bare = buildLaunches([record(KEY, "p1", 100)])[0].record;
  assert.equal(
    hasFounderCommitments(bare),
    false,
    "bare record is not live-ready",
  );

  const committed = buildLaunches([
    record(KEY, "p2", 100, {
      longPitch:
        "Built the protocol core; three researchers; the thesis fails if usage stalls.",
      budget: "5000000000",
      updateCadence: "monthly with KPIs",
      ipList: ["https://github.com/x/y", "https://docs.example.com/"],
    }),
    // the record fixture also needs a buzz-channel tag for the review->live gate
  ]);
  // the fixture's record() doesn't set channels; patch by building a valid
  // launch and asserting the gate only needs the four fields, channels included.
  const rec = committed[0].record;
  assert.equal(
    rec.longPitch,
    "Built the protocol core; three researchers; the thesis fails if usage stalls.",
  );
  assert.equal(rec.budget, "5000000000");
  assert.equal(rec.updateCadence, "monthly with KPIs");
  assert.deepEqual(rec.ipList, [
    "https://github.com/x/y",
    "https://docs.example.com/",
  ]);
  // The gate also needs a bound channel — the fixture carries none.
  assert.equal(hasFounderCommitments(rec), false);
  // Absent fields stay null/[] — no fabricated commitments.
  assert.equal(bare.longPitch, null);
  assert.equal(bare.updateCadence, null);
  assert.deepEqual(bare.ipList, []);
});

test("a score root parses and malformed roots are refused", () => {
  const KEY = "a".repeat(64);
  const good = {
    id: "s1",
    pubkey: KEY,
    created_at: 300,
    kind: 37006,
    tags: [["d", "trustgraphs.output.nostr-member.v1:12"]],
    content: JSON.stringify({
      program: "trustgraphs.output.nostr-member.v1",
      root: `0x${"11".repeat(32)}`,
      epoch: "12",
      anchorBlock: 500,
      indexerUrl: "https://idx.example.com",
    }),
    sig: "sig",
  };
  const parsed = parseScoreRoot(good);
  assert.equal(parsed.program, "trustgraphs.output.nostr-member.v1");
  assert.equal(parsed.root, `0x${"11".repeat(32)}`);
  assert.equal(parsed.epoch, "12");
  assert.equal(parsed.anchorBlock, 500);
  assert.equal(parsed.indexerUrl, "https://idx.example.com");

  // A short root is not a Merkle root: refuse rather than claim authority.
  assert.equal(
    parseScoreRoot({
      ...good,
      id: "s2",
      content: JSON.stringify({ program: "p", root: "0xdead", epoch: "1" }),
    }),
    null,
  );
  // Right kind but no program: refused.
  assert.equal(
    parseScoreRoot({
      ...good,
      id: "s3",
      content: JSON.stringify({ root: `0x${"11".repeat(32)}`, epoch: "1" }),
    }),
    null,
  );
});

test("a return-capital proposal parses with its kind", () => {
  const KEY = "a".repeat(64);
  const _launches = buildLaunches([record(KEY, "nebula", 100)]);
  const coord = `37001:${KEY}:nebula`;
  const prop = {
    id: "prop-1",
    pubkey: "b".repeat(64),
    created_at: 150,
    kind: 47004,
    tags: [["a", coord]],
    content: JSON.stringify({
      kind: "return-capital",
      title: "Return the remaining treasury pro-rata",
      state: "open",
    }),
    sig: "sig",
  };
  const parsed = parseLaunchProposal(prop);
  assert.equal(parsed.kind, "return-capital");
  assert.equal(parsed.title, "Return the remaining treasury pro-rata");
  assert.equal(parsed.state, "open");
});

test("how the reviewers will work is read as the founder wrote it, and a huge one is cut rather than shown whole", () => {
  const [launch] = buildLaunches([
    record(ALICE, "nebula", 100, {
      reviewerTerms: "Each answers within 7 days.",
    }),
  ]);
  assert.equal(launch.record.reviewerTerms, "Each answers within 7 days.");
  const [huge] = buildLaunches([
    record(ALICE, "orion", 100, { reviewerTerms: "x".repeat(50_000) }),
  ]);
  assert.equal(huge.record.reviewerTerms.length, 2_000);
  const [none] = buildLaunches([record(ALICE, "vega", 100)]);
  assert.equal(none.record.reviewerTerms, null);
});

test("a removal hides the versions it came after, and a record published after it shows", () => {
  const coordinate = launchCoordinate(ALICE, "nebula");
  const removed = new Map([[coordinate, 200]]);
  assert.deepEqual(
    buildLaunches([record(ALICE, "nebula", 150)], removed).length,
    0,
  );
  assert.deepEqual(
    buildLaunches([record(ALICE, "nebula", 200)], removed).length,
    0,
  );
  const again = buildLaunches([record(ALICE, "nebula", 250)], removed);
  assert.equal(again.length, 1);
  assert.equal(again[0].record.createdAt, 250);
});

test("an author's removals are read by coordinate and time, and only their own count", () => {
  const removal = (pubkey, coordinate, createdAt) => ({
    id: `${pubkey.slice(0, 4)}${createdAt}`.padEnd(64, "0"),
    pubkey,
    created_at: createdAt,
    kind: 5,
    tags: [["a", coordinate]],
    content: "",
    sig: "sig",
  });
  const removals = launchRemovals([
    removal(ALICE, launchCoordinate(ALICE, "creaton"), 300),
    removal(ALICE, launchCoordinate(ALICE, "creaton"), 100),
    removal(ALICE, launchCoordinate(ALICE, "old-idea"), 50),
    // Someone else's deletion names nothing of Alice's.
    removal(BOB, launchCoordinate(ALICE, "nebula"), 400),
    // A deletion of another kind of record is not a launch removal.
    removal(ALICE, `30023:${ALICE}:creaton`, 500),
  ]);
  assert.equal(removals.get(launchCoordinate(ALICE, "creaton")), 300);
  assert.equal(removals.has(launchCoordinate(ALICE, "nebula")), false);
  assert.deepEqual(removedLaunchIds(removals, ALICE).sort(), [
    "creaton",
    "old-idea",
  ]);
  assert.deepEqual(removedLaunchIds(removals, BOB), []);
});
