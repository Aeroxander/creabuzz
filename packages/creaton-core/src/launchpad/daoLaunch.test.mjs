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
// cast keccak "alpha shipped" / "mainnet live"
const CHECK_ALPHA =
  "0x584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8";
const CHECK_MAINNET =
  "0xe47c52aa8e6c9ea6180a45a06bcb534f0d192a2f1cab93cb6974e060ffea4e2f";
const ZERO = "0x0000000000000000000000000000000000000000";
const LOCK = "0x1111111111111111111111111111111111111111";
const JUDGE_A = "0x00000000000000000000000000000000000000a1";
const JUDGE_B = "0x00000000000000000000000000000000000000a2";
const JUDGE_C = "0x00000000000000000000000000000000000000a3";
const NOW = 1_700_000_000;
const panel = (over = {}) => ({
  reviewers: [JUDGE_A, JUDGE_B, JUDGE_C],
  quorum: 2,
  bond: 0n,
  bondToken: "",
  endsAt: 1_900_000_000,
  now: NOW,
  ...over,
});
const inputs = (over = {}) => ({
  name: "Nebula",
  symbol: "NEB",
  totalSupply: "1000",
  allocation: { sale: 40, team: 30, dao: 30 },
  team: [
    { address: SEAT_A, percent: 75 },
    { address: SEAT_B, percent: 25 },
  ],
  milestones: [
    { check: "alpha shipped", percent: 40 },
    { check: "mainnet live", percent: 60 },
  ],
  panel: panel(),
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

test("the supply is split into the sale, the locked team seats and the DAO's own, to the wei", () => {
  const plan = planDaoLaunch(inputs());
  assert.equal(plan.saleSupply, 400n * WAD);
  assert.deepEqual(plan.teamShares, [225n * WAD, 75n * WAD]);
  assert.equal(plan.daoShares, 300n * WAD);
  assert.equal(
    plan.saleSupply + plan.teamShares.reduce((a, b) => a + b) + plan.daoShares,
    plan.totalSupply,
  );
  // Each milestone is a hash of the words its reviewers judge it by, and the share of the allocation it unlocks.
  assert.deepEqual(plan.milestoneChecks, [CHECK_ALPHA, CHECK_MAINNET]);
  assert.deepEqual(plan.milestoneBps, [4000, 6000]);
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
  field({ milestones: [{ check: "  ", percent: 50 }] }, "milestones");
  field({ milestones: [{ check: "shipped", percent: 0 }] }, "milestones");
  field({ milestones: [{ check: "shipped", percent: 101 }] }, "milestones");
  field(
    {
      milestones: [
        { check: "shipped", percent: 60 },
        { check: "released", percent: 50 },
      ],
    },
    "milestones",
  );
  field(
    {
      milestones: [
        { check: "shipped", percent: 30 },
        { check: " shipped ", percent: 30 },
      ],
    },
    "milestones",
  );
  field(
    {
      milestones: Array.from({ length: 9 }, (_, i) => ({
        check: "step " + i,
        percent: 5,
      })),
    },
    "milestones",
  );
  field({ currency: "usd" }, "currency");
  field({ floorPrice: "5" }, "floor price");
  field({ tickSpacing: "1" }, "tick spacing");
  field({ requiredRaised: "0" }, "raise target");
  field({ startBlock: null }, "blocks");
  field({ endBlock: 100 }, "blocks");
  field({ claimBlock: 102 }, "blocks");
  field({ salt: "0x12" }, "salt");
});

test("with no team allocation there are no seats to name and nothing to lock", () => {
  const plan = planDaoLaunch(
    inputs({
      allocation: { sale: 50, team: 0, dao: 50 },
      team: [],
      milestones: [],
    }),
  );
  assert.deepEqual(plan.teamShares, []);
  assert.deepEqual(plan.milestoneChecks, []);
  assert.equal(plan.daoShares, 500n * WAD);
});

test("a team with no milestones is simply not locked, and milestones may leave part of the allocation free", () => {
  const free = planDaoLaunch(inputs({ milestones: [] }));
  assert.deepEqual(free.milestoneBps, []);
  assert.equal(describeDaoLaunch(free).teamLockedBps, 0);
  const partly = planDaoLaunch(
    inputs({ milestones: [{ check: "alpha shipped", percent: 25 }] }),
  );
  assert.deepEqual(partly.milestoneBps, [2500]);
  assert.equal(describeDaoLaunch(partly).teamLockedBps, 2500);
  assert.equal(
    describeDaoLaunch(planDaoLaunch(inputs())).teamLockedBps,
    10_000,
  );
});

test("the launch calldata is exactly what cast encodes for the kit's launch(Params)", () => {
  const executor = "0x4444444444444444444444444444444444444444";
  const data = encodeKitLaunch(planDaoLaunch(inputs()), executor);
  assert.equal(data.slice(0, 10), SELECTOR_KIT_LAUNCH);
  assert.equal(
    data,
    "0xd4d489180000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000008ac7230489e800001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e0000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000004a0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000713fb30000000000000000000000000000000000000000000000001043561a8829300000000000000000000000000000000000000000000000000015af1d78b58c40000000000000000000000000000000000000000000000000000000000000000005201350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000000000000000000000000000064e6562756c61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000034e454200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000c328093e61ee4000000000000000000000000000000000000000000000000000410d586a20a4c00000000000000000000000000000000000000000000000000000000000000000002584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8e47c52aa8e6c9ea6180a45a06bcb534f0d192a2f1cab93cb6974e060ffea4e2f00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000fa00000000000000000000000000000000000000000000000000000000000001770000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000a200000000000000000000000000000000000000000000000000000000000000a300000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000001b1ae4d6e2ef500000000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000104c4b4000000000014c4b40000000000100000000000000000000000000000000",
  );
});

test("the milestone panel rides in the launch, as cast encodes it, with its bond in the sale currency by default", () => {
  const executor = "0x4444444444444444444444444444444444444444";
  const plan = planDaoLaunch(inputs({ panel: panel({ bond: 25_000_000n }) }));
  assert.equal(
    plan.panel.bondToken,
    "0x3333333333333333333333333333333333333333",
  );
  assert.equal(
    plan.panel.currency,
    "0x3333333333333333333333333333333333333333",
  );
  assert.equal(
    encodeKitLaunch(plan, executor),
    "0xd4d489180000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000008ac7230489e800001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e0000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000004a0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000017d78400000000000000000000000003333333333333333333333333333333333333333000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000713fb30000000000000000000000000000000000000000000000001043561a8829300000000000000000000000000000000000000000000000000015af1d78b58c40000000000000000000000000000000000000000000000000000000000000000005201350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000000000000000000000000000064e6562756c61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000034e454200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000c328093e61ee4000000000000000000000000000000000000000000000000000410d586a20a4c00000000000000000000000000000000000000000000000000000000000000000002584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8e47c52aa8e6c9ea6180a45a06bcb534f0d192a2f1cab93cb6974e060ffea4e2f00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000fa00000000000000000000000000000000000000000000000000000000000001770000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000a200000000000000000000000000000000000000000000000000000000000000a300000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000001b1ae4d6e2ef500000000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000104c4b4000000000014c4b40000000000100000000000000000000000000000000",
  );
  // No bond, no bond token: a token named without a bond is not encoded.
  const none = planDaoLaunch(
    inputs({
      panel: panel({ bondToken: "0x00000000000000000000000000000000000000d1" }),
    }),
  );
  assert.equal(none.panel.bondToken, ZERO);
  assert.equal(
    encodeKitLaunch(none, executor),
    encodeKitLaunch(planDaoLaunch(inputs()), executor),
  );
  // Another token for the bond is carried as named.
  const other = planDaoLaunch(
    inputs({
      panel: panel({
        bond: 5n,
        bondToken: "0x00000000000000000000000000000000000000D1",
      }),
    }),
  );
  assert.equal(
    other.panel.bondToken,
    "0x00000000000000000000000000000000000000d1",
  );
});

test("milestones need a panel, and a panel that could not be made is refused with the field to fix", () => {
  field({ panel: null }, "panel");
  field({ panel: panel({ reviewers: [] }) }, "panel");
  field({ panel: panel({ reviewers: ["nope"] }) }, "panel");
  field({ panel: panel({ reviewers: [JUDGE_A, JUDGE_A] }) }, "panel");
  field({ panel: panel({ reviewers: [ZERO] }) }, "panel");
  // A team member cannot judge the team's milestones (checked here, before the contract would refuse the launch).
  field(
    {
      panel: panel({
        reviewers: [JUDGE_A, SEAT_A.toUpperCase().replace("0X", "0x")],
      }),
    },
    "panel",
  );
  field({ panel: panel({ quorum: 0 }) }, "panel");
  field({ panel: panel({ quorum: 4 }) }, "panel");
  field({ panel: panel({ bond: -1n }) }, "panel");
  field({ panel: panel({ bond: 1n << 128n }) }, "panel");
  field({ panel: panel({ bond: 1n, bondToken: "0x12" }) }, "panel");
  field({ panel: panel({ endsAt: NOW + 3600 }) }, "panel");
  field(
    {
      panel: panel({
        reviewers: Array.from(
          { length: 33 },
          (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
        ),
        quorum: 1,
      }),
    },
    "panel",
  );
  // The panel's claims and bond are paid in a token, so the native currency cannot launch with milestones.
  field({ currency: null }, "currency");
  // With nothing to judge there is no panel, and none is needed.
  const free = planDaoLaunch(inputs({ milestones: [], panel: null }));
  assert.equal(free.panel, null);
  const ignored = planDaoLaunch(inputs({ milestones: [] }));
  assert.equal(
    ignored.panel,
    null,
    "a panel named for no milestones is dropped, not encoded",
  );
});

test("the executor is asked for by its launch salt, and a launch salt is stable per launch", () => {
  const salt = launchSalt("nebula");
  assert.equal(
    encodeKitPredictExecutor(SEAT_A, salt),
    `${SELECTOR_KIT_PREDICT_EXECUTOR}${"0".repeat(24)}${SEAT_A.slice(2)}${salt.slice(2)}`,
  );
  // cast calldata "predictExecutor(address,bytes32)" 0x1111… 0x2222…
  assert.equal(
    encodeKitPredictExecutor(SEAT_A, `0x${"22".repeat(32)}`),
    "0x4e9a46c700000000000000000000000011111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222",
  );
  assert.throws(() => encodeKitPredictExecutor("0x12", salt));
  assert.equal(salt, launchSalt("nebula"));
  assert.notEqual(salt, launchSalt("other"));
});

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const topicOf = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const launched = (emitter, lock = LOCK) => ({
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
    word(lock),
    word(400n * WAD),
  ].join("")}`,
});

test("the launch is read from the kit's own event, and only from the kit", () => {
  const event = decodeKitLaunched([launched(KIT)], KIT);
  assert.deepEqual(event, {
    dao: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    launcher: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    shares: "0xcccccccccccccccccccccccccccccccccccccccc",
    executor: "0xdddddddddddddddddddddddddddddddddddddddd",
    auction: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    lock: LOCK,
    saleSupply: 400n * WAD,
  });
  // A launch that locked nothing has no lock to point at.
  assert.equal(decodeKitLaunched([launched(KIT, ZERO)], KIT).lock, null);
  // Anyone can emit an event with this topic; a launch is only recorded from a log the kit emitted.
  assert.equal(
    decodeKitLaunched(
      [launched("0x9999999999999999999999999999999999999999")],
      KIT,
    ),
    null,
  );
  assert.equal(
    decodeKitLaunched([{ ...launched(KIT), topics: ["0xdead"] }], KIT),
    null,
  );
  assert.equal(
    decodeKitLaunched([{ ...launched(KIT), data: "0x1234" }], KIT),
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
