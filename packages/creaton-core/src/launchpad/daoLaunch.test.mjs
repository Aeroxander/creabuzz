import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DaoLaunchPlanError,
  describeDaoLaunch,
  SELECTOR_KIT_LAUNCH,
  SELECTOR_KIT_PREDICT_EXECUTOR,
  TOPIC_KIT_LAUNCHED,
  decodeKitLaunched,
  encodeKitLaunch,
  encodeKitPredictExecutor,
  launchSalt,
  planDaoLaunch,
} from "./daoLaunch.ts";

const WAD = 10n ** 18n;
const SEAT_A = "0x1111111111111111111111111111111111111111";
const SEAT_B = "0x2222222222222222222222222222222222222222";
const KIT = "0x5555555555555555555555555555555555555555";
const inputs = (over = {}) => ({
  name: "Nebula",
  symbol: "NEB",
  totalSupply: "1000",
  allocation: { sale: 40, team: 30, dao: 30 },
  team: [
    { address: SEAT_A, percent: 75 },
    { address: SEAT_B, percent: 25 },
  ],
  vesting: { cliffDays: 180, durationDays: 1460 },
  proposalThreshold: "10",
  currency: "0x3333333333333333333333333333333333333333",
  floorPrice: "79228162514264337593543950336",
  tickSpacing: "79228162514264337593543950336",
  requiredRaised: "500000000000000000000",
  startBlock: 100,
  endBlock: 102,
  claimBlock: 105,
  salt: launchSalt("nebula"),
  ...over,
});
const field = (over, name) =>
  assert.throws(
    () => planDaoLaunch(inputs(over)),
    (error) => error instanceof DaoLaunchPlanError && error.field === name,
    `expected a ${name} error`,
  );

test("the supply is split into the sale, the vested team seats and the DAO's own, to the wei", () => {
  const plan = planDaoLaunch(inputs());
  assert.equal(plan.saleSupply, 400n * WAD);
  assert.deepEqual(plan.teamShares, [225n * WAD, 75n * WAD]);
  assert.equal(plan.daoShares, 300n * WAD);
  assert.equal(
    plan.saleSupply + plan.teamShares.reduce((a, b) => a + b) + plan.daoShares,
    plan.totalSupply,
  );
  assert.equal(plan.vestCliff, 180n * 86400n);
  assert.equal(plan.vestDuration, 1460n * 86400n);
  assert.equal(plan.proposalThreshold, 10n * WAD);
  assert.deepEqual(plan.team, [SEAT_A, SEAT_B]);
});

test("rounding never loses a wei: the first seat and the DAO's allocation take what is left over", () => {
  const plan = planDaoLaunch(
    inputs({
      totalSupply: "1001",
      allocation: { sale: 33, team: 33, dao: 34 },
      team: [
        { address: SEAT_A, percent: 33 },
        { address: SEAT_B, percent: 67 },
      ],
    }),
  );
  const parts =
    plan.saleSupply + plan.teamShares.reduce((a, b) => a + b) + plan.daoShares;
  assert.equal(parts, 1001n * WAD);
});

test("a plan that cannot launch is refused with the field to fix, before any wallet is asked", () => {
  field({ name: "  " }, "name");
  field({ symbol: "TOOLONGSYMBOL" }, "symbol");
  field({ totalSupply: "1.5" }, "totalSupply");
  field({ allocation: { sale: 40, team: 30, dao: 20 } }, "allocation");
  field({ allocation: { sale: 0, team: 50, dao: 50 } }, "sale share");
  field({ team: [] }, "team");
  field({ team: [{ address: SEAT_A, percent: 60 }] }, "team");
  field({ team: [{ address: "nope", percent: 100 }] }, "team");
  field({ vesting: { cliffDays: 400, durationDays: 100 } }, "vesting");
  field({ currency: "usd" }, "currency");
  field({ floorPrice: "5" }, "floor price");
  field({ tickSpacing: "1" }, "tick spacing");
  field({ requiredRaised: "0" }, "raise target");
  field({ startBlock: null }, "blocks");
  field({ endBlock: 100 }, "blocks");
  field({ claimBlock: 102 }, "blocks");
  field({ salt: "0x12" }, "salt");
});

test("with no team allocation there are no seats to name and no vesting to set", () => {
  const plan = planDaoLaunch(
    inputs({
      allocation: { sale: 50, team: 0, dao: 50 },
      team: [],
      vesting: { cliffDays: 0, durationDays: 0 },
    }),
  );
  assert.deepEqual(plan.teamShares, []);
  assert.equal(plan.daoShares, 500n * WAD);
});

test("the launch calldata is exactly what cast encodes for the kit's launch(Params)", () => {
  const executor = "0x4444444444444444444444444444444444444444";
  const data = encodeKitLaunch(planDaoLaunch(inputs()), executor);
  assert.equal(data.slice(0, 10), SELECTOR_KIT_LAUNCH);
  assert.equal(
    data,
    "0xd4d9998d000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000008ac7230489e800001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000ed4e00000000000000000000000000000000000000000000000000000000000784ce0000000000000000000000000000000000000000000000001043561a8829300000000000000000000000000000000000000000000000000015af1d78b58c40000000000000000000000000000000000000000000000000000000000000000003001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e00000000000000000000000000000000000000000000000000000000000000064e6562756c61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000034e454200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000c328093e61ee4000000000000000000000000000000000000000000000000000410d586a20a4c000000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000001b1ae4d6e2ef500000000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000104c4b4000000000014c4b40000000000100000000000000000000000000000000",
  );
});

test("the executor is asked for by its launch salt, and a launch salt is stable per launch", () => {
  const salt = launchSalt("nebula");
  assert.equal(
    encodeKitPredictExecutor(salt),
    `${SELECTOR_KIT_PREDICT_EXECUTOR}${salt.slice(2)}`,
  );
  assert.equal(salt, launchSalt("nebula"));
  assert.notEqual(salt, launchSalt("other"));
});

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const topicOf = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const launched = (emitter, vaults) => ({
  address: emitter,
  topics: [
    TOPIC_KIT_LAUNCHED,
    topicOf("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    topicOf("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  ],
  data: `0x${[
    word("0xcccccccccccccccccccccccccccccccccccccccc"),
    word("0xdddddddddddddddddddddddddddddddddddddddd"),
    word("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
    word(0xa0),
    word(400n * WAD),
    word(vaults.length),
    ...vaults.map(word),
  ].join("")}`,
});

test("the launch is read from the kit's own event, and only from the kit", () => {
  const event = decodeKitLaunched(
    [
      launched(KIT, [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ]),
    ],
    KIT,
  );
  assert.deepEqual(event, {
    dao: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    launcher: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    shares: "0xcccccccccccccccccccccccccccccccccccccccc",
    executor: "0xdddddddddddddddddddddddddddddddddddddddd",
    auction: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    vaults: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ],
    saleSupply: 400n * WAD,
  });
  // Anyone can emit an event with this topic; a launch is only recorded from a log the kit emitted.
  assert.equal(
    decodeKitLaunched(
      [launched("0x9999999999999999999999999999999999999999", [])],
      KIT,
    ),
    null,
  );
  assert.equal(
    decodeKitLaunched([{ ...launched(KIT, []), topics: ["0xdead"] }], KIT),
    null,
  );
  assert.equal(
    decodeKitLaunched([{ ...launched(KIT, []), data: "0x1234" }], KIT),
    null,
  );
  assert.equal(decodeKitLaunched([], KIT), null);
});

test("backers' exit share counts the team's locked Shares and leaves the DAO's own out", () => {
  // 400 sold + 300 team, 300 kept by the DAO: backers are 400 of the 700 that can leave.
  assert.equal(describeDaoLaunch(planDaoLaunch(inputs())).backersExitBps, 5714);
  // No team allocation: the whole treasury is the backers'.
  const noTeam = planDaoLaunch(
    inputs({ allocation: { sale: 40, team: 0, dao: 60 }, team: [] }),
  );
  assert.equal(describeDaoLaunch(noTeam).backersExitBps, 10_000);
});
