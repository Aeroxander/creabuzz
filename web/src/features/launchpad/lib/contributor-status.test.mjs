import assert from "node:assert/strict";
import test from "node:test";

import {
  contributorStatus,
  KIT_LAUNCH_TOPICS,
  kitLaunchLogs,
  TOPIC_CONTRIBUTOR_LAUNCHED,
  TOPIC_CONTRIBUTOR_LAUNCHED_V2,
  TOPIC_CONTRIBUTOR_LAUNCHED_V3,
} from "./contributor-status.ts";

test("the kit's launch event is the one the contract emits", () => {
  // cast keccak 'ContributorProjectLaunched(address,address,address,bytes32,uint256)'
  assert.equal(
    TOPIC_CONTRIBUTOR_LAUNCHED,
    "0x7f4eb55556e4a4d7639e36b6ec8b0e6d4ab4fcfff92dd9c201bed8e870716583",
  );
});

test("the pool kit's launch event is the one the contract emits, and is not in the pinned list of the older kits'", () => {
  // cast keccak 'ContributorProjectLaunchedV3(address,address,address,address,address,address,uint256,address)'
  assert.equal(
    TOPIC_CONTRIBUTOR_LAUNCHED_V3,
    "0x380a3c60d2cbbdbb8d1ae519d55227a94cbbda306279fa58a970d2400e9ec05c",
  );
  assert.ok(!KIT_LAUNCH_TOPICS.includes(TOPIC_CONTRIBUTOR_LAUNCHED_V3));
});

test("the weekly-sale kit's launch event is the one the contract emits", () => {
  // cast keccak 'ContributorProjectLaunchedV2(address,address,address,address,address,address,uint256)'
  assert.equal(
    TOPIC_CONTRIBUTOR_LAUNCHED_V2,
    "0xe8f7ba7a252744bf8c12c25ded39950b2eec426345772885e105d09f1de3cab6",
  );
  assert.deepEqual(KIT_LAUNCH_TOPICS, [
    TOPIC_CONTRIBUTOR_LAUNCHED,
    TOPIC_CONTRIBUTOR_LAUNCHED_V2,
  ]);
});

test("a project counts as made by the kit on either launch event, with the DAO in the third topic", async () => {
  const dao = `0x${"0".repeat(24)}${"d1".repeat(20)}`;
  const asked = [];
  const only = (event) => async (topics) => {
    asked.push(topics);
    return topics[0] === event ? [{ topics: [event, "founder", dao] }] : [];
  };
  for (const event of KIT_LAUNCH_TOPICS) {
    const logs = await kitLaunchLogs(only(event), dao);
    assert.equal(logs.length, 1, event);
  }
  assert.deepEqual(await kitLaunchLogs(async () => [], dao), []);
  assert.ok(asked.every((topics) => topics[1] === null && topics[2] === dao));
  // A node error is not an empty answer.
  await assert.rejects(
    kitLaunchLogs(async () => {
      throw new Error("node down");
    }, dao),
    /node down/,
  );
});

const rules = (over = {}) => ({
  kind: "rules",
  rules: {
    awardsOnly: true,
    issuanceCapBps: 65_535,
    yearStart: 0,
    yearBase: 0n,
    issuedThisYear: 0n,
    transfersLocked: true,
    unlockNoticeRequired: true,
    unlockAnnouncedAt: 0,
    transferExempt: `0x${"0".repeat(40)}`,
    ...over,
  },
});

test("the start is said as checked: by the kit's event, or only as the record says", () => {
  assert.deepEqual(contributorStatus("kit", rules()).start, {
    label: "No token sale",
    tone: "plain",
  });
  assert.deepEqual(contributorStatus("record", rules()).start, {
    label: "No token sale (not checked)",
    tone: "caution",
  });
  assert.equal(contributorStatus("reading", rules()).start, null);
});

test("new Shares 'only for reviewed work' only when the Shares say so", () => {
  assert.deepEqual(contributorStatus("kit", rules()).shares, {
    label: "New Shares only for reviewed work",
    tone: "plain",
  });
  assert.deepEqual(
    contributorStatus("kit", rules({ awardsOnly: false })).shares,
    {
      label: "A vote can create Shares",
      tone: "caution",
    },
  );
  // A read that failed, Shares made before the rule, and one still reading never keep the promise.
  assert.deepEqual(contributorStatus("kit", { kind: "error" }).shares, {
    label: "Couldn't check its Shares",
    tone: "caution",
  });
  assert.deepEqual(contributorStatus("kit", { kind: "predates" }).shares, {
    label: "A vote can create Shares",
    tone: "caution",
  });
  assert.equal(contributorStatus("kit", { kind: "reading" }).shares, null);
});

test("trading as the lock says, with no announcement invented and no browser clock", () => {
  assert.deepEqual(contributorStatus("kit", rules()).trading, {
    label: "Shares can't be sold",
    tone: "plain",
  });
  // Locked, but needing no notice: one vote opens it, and nothing was announced.
  assert.deepEqual(
    contributorStatus("kit", rules({ unlockNoticeRequired: false })).trading,
    { label: "One vote can make Shares sellable", tone: "caution" },
  );
  // Announced: the date it can open, the same whether that date has passed or not.
  const announced = Date.UTC(2026, 9, 1) / 1000;
  assert.deepEqual(
    contributorStatus("kit", rules({ unlockAnnouncedAt: announced })).trading,
    { label: "Can become sellable from October 31, 2026", tone: "caution" },
  );
  assert.deepEqual(
    contributorStatus("kit", rules({ transfersLocked: false })).trading,
    { label: "Shares can be sold", tone: "plain" },
  );
  assert.equal(contributorStatus("kit", { kind: "error" }).trading, null);
  assert.deepEqual(contributorStatus("kit", { kind: "predates" }).trading, {
    label: "One vote can make Shares sellable",
    tone: "caution",
  });
});
