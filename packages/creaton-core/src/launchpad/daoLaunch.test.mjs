import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHALLENGE_DEFAULTS,
  DaoLaunchPlanError,
  daoLaunchReceiptContent,
  describeDaoLaunch,
  SELECTOR_KIT_LAUNCH,
  SELECTOR_KIT_LAUNCH_CHALLENGED,
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
  allocation: { sale: 60, team: 30, dao: 10 },
  team: [
    { address: SEAT_A, percent: 75 },
    { address: SEAT_B, percent: 25 },
  ],
  milestones: [
    { check: "alpha shipped", percent: 50 },
    { check: "mainnet live", percent: 50 },
  ],
  panel: panel(),
  proposalThreshold: "10",
  currency: "0x3333333333333333333333333333333333333333",
  floorPrice: "79228162514264337593543950336",
  tickSpacing: "79228162514264337593543950336",
  requiredRaised: "600000000000000000000", // the whole 600 on sale at the floor of 1 (D74)
  startBlock: 100,
  endBlock: 102,
  claimBlock: 105,
  salt: launchSalt("nebula"),
  ...over,
});
/** A launch with no team: nothing to lock, so no milestones (D75 requires them for a team). */
const NO_TEAM = {
  allocation: { sale: 80, team: 0, dao: 20 },
  team: [],
  milestones: [],
  requiredRaised: "800000000000000000000",
};
const field = (over, name) =>
  assert.throws(
    () => planDaoLaunch(inputs(over)),
    (error) => error instanceof DaoLaunchPlanError && error.field === name,
    `expected a ${name} error`,
  );

test("the supply is split into the sale, the locked team seats and the DAO's own, to the wei", () => {
  const plan = planDaoLaunch(inputs());
  assert.equal(plan.saleSupply, 600n * WAD);
  assert.deepEqual(plan.teamShares, [225n * WAD, 75n * WAD]);
  assert.equal(plan.daoShares, 100n * WAD);
  assert.equal(
    plan.saleSupply + plan.teamShares.reduce((a, b) => a + b) + plan.daoShares,
    plan.totalSupply,
  );
  // Each milestone is a hash of the words its reviewers judge it by, and the share of the allocation it unlocks.
  assert.deepEqual(plan.milestoneChecks, [CHECK_ALPHA, CHECK_MAINNET]);
  assert.deepEqual(plan.milestoneBps, [5000, 5000]);
  assert.equal(plan.proposalThreshold, 10n * WAD);
  assert.deepEqual(plan.team, [SEAT_A, SEAT_B]);
});

test("rounding never loses a wei: the first seat and the DAO's allocation take what is left over", () => {
  const plan = planDaoLaunch(
    inputs({
      totalSupply: "1001",
      allocation: { sale: 61, team: 33, dao: 6 },
      requiredRaised: "700000000000000000000",
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
      allocation: { sale: 80, team: 0, dao: 20 },
      team: [],
      milestones: [],
      requiredRaised: "800000000000000000000",
    }),
  );
  assert.deepEqual(plan.teamShares, []);
  assert.deepEqual(plan.milestoneChecks, []);
  assert.equal(plan.daoShares, 200n * WAD);
});

test("the kit's limits are checked first: the split, every team Share behind 2 to 8 milestones, a sale that sells out", () => {
  // D75: the sale at least 60%, the team at most 35%, the DAO's own at most 20%.
  field({ allocation: { sale: 59, team: 30, dao: 11 } }, "sale share");
  field({ allocation: { sale: 60, team: 36, dao: 4 } }, "team share");
  field({ allocation: { sale: 60, team: 19, dao: 21 } }, "treasury share");
  // A team's Shares are all locked, behind at least two milestones, none unlocking more than half.
  field({ milestones: [] }, "milestones");
  field({ milestones: [{ check: "everything", percent: 100 }] }, "milestones");
  field(
    {
      milestones: [
        { check: "alpha shipped", percent: 50 },
        { check: "mainnet live", percent: 49 },
      ],
    },
    "milestones",
  );
  field(
    {
      milestones: [
        { check: "alpha shipped", percent: 51 },
        { check: "mainnet live", percent: 49 },
      ],
    },
    "milestones",
  );
  // D74: the target is the whole tranche at the floor.
  field({ requiredRaised: "599999999999999999999" }, "raise target");
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
    "0xd4d489180000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000008ac7230489e800001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e0000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000004a0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000002086ac35105260000000000000000000000000000000000000000000000000000000000000000005201350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000000000000000000000000000064e6562756c61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000034e454200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000c328093e61ee4000000000000000000000000000000000000000000000000000410d586a20a4c00000000000000000000000000000000000000000000000000000000000000000002584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8e47c52aa8e6c9ea6180a45a06bcb534f0d192a2f1cab93cb6974e060ffea4e2f000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000001388000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000a200000000000000000000000000000000000000000000000000000000000000a300000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000002086ac351052600000000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000104c4b4000000000014c4b40000000000100000000000000000000000000000000",
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
    "0xd4d489180000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000008ac7230489e800001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e0000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000004a0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000017d78400000000000000000000000003333333333333333333333333333333333333333000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000002086ac35105260000000000000000000000000000000000000000000000000000000000000000005201350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000000000000000000000000000064e6562756c61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000034e454200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000c328093e61ee4000000000000000000000000000000000000000000000000000410d586a20a4c00000000000000000000000000000000000000000000000000000000000000000002584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8e47c52aa8e6c9ea6180a45a06bcb534f0d192a2f1cab93cb6974e060ffea4e2f000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000001388000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000a200000000000000000000000000000000000000000000000000000000000000a300000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000002086ac351052600000000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000104c4b4000000000014c4b40000000000100000000000000000000000000000000",
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
  const free = planDaoLaunch(inputs({ ...NO_TEAM, panel: null }));
  assert.equal(free.panel, null);
  const ignored = planDaoLaunch(inputs(NO_TEAM));
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

test("backers' exit share leaves out the DAO's own, and the team's Shares until their milestones (D72)", () => {
  // 600 sold + 300 team, 100 kept by the DAO: before any milestone the locked 300 are out, so the backers can leave
  // with all of it; once every milestone has unlocked they are 600 of the 900.
  const summary = describeDaoLaunch(planDaoLaunch(inputs()));
  assert.equal(summary.backersExitBpsBeforeMilestones, 10_000);
  assert.equal(summary.backersExitBps, 6666);
  // No team allocation: the whole treasury is the backers' either way.
  const noTeam = planDaoLaunch(
    inputs({
      allocation: { sale: 80, team: 0, dao: 20 },
      team: [],
      milestones: [],
      requiredRaised: "800000000000000000000",
    }),
  );
  assert.equal(describeDaoLaunch(noTeam).backersExitBps, 10_000);
  assert.equal(
    describeDaoLaunch(noTeam).backersExitBpsBeforeMilestones,
    10_000,
  );
});

// ---- milestones that unlock unless holders object -----------------------------------------------

const challengeInputs = (over = {}) =>
  inputs({ panel: null, challenge: {}, ...over });

test("a challenged launch takes its terms from the defaults and a bond that is a share of the raise", () => {
  const plan = planDaoLaunch(challengeInputs());
  assert.equal(plan.panel, null);
  assert.deepEqual(plan.challenge, {
    window: CHALLENGE_DEFAULTS.window,
    votePeriod: CHALLENGE_DEFAULTS.votePeriod,
    clawback: CHALLENGE_DEFAULTS.clawback,
    minRejectBps: CHALLENGE_DEFAULTS.minRejectBps,
    bondToken: "0x3333333333333333333333333333333333333333",
    // 1% of the 500 raise target, and a tenth of that for an objector.
    bond: 6n * WAD, // 1% of the 600 target
    deposit: (6n * WAD) / 10n,
  });
  const custom = planDaoLaunch(
    challengeInputs({
      challenge: {
        window: 14 * 86_400,
        minRejectBps: 500,
        bond: 7n,
        deposit: 1n,
      },
    }),
  );
  assert.equal(custom.challenge.window, 14 * 86_400);
  assert.equal(custom.challenge.minRejectBps, 500);
  assert.equal(custom.challenge.bond, 7n);
  assert.equal(custom.challenge.deposit, 1n);
});

test("a challenge that the lock would refuse is refused first, with the field to fix", () => {
  const bad = (challenge) => field({ panel: null, challenge }, "challenge");
  bad({ window: 3600 });
  bad({ window: 31 * 86_400 });
  bad({ window: 86_400.5 });
  bad({ votePeriod: 3600 });
  bad({ votePeriod: 31 * 86_400 });
  bad({ clawback: -1 });
  bad({ clawback: 181 * 86_400 });
  bad({ minRejectBps: 0 });
  bad({ minRejectBps: 5001 });
  bad({ bond: -1n });
  bad({ bond: 1n << 128n });
  bad({ deposit: 1n << 128n });
  // Named reviewers and the challenge are two ways to judge the same milestones: one, not both.
  field({ challenge: {} }, "challenge");
  // A bond is paid in the sale's token: a sale in the chain's own currency has none.
  field({ panel: null, challenge: {}, currency: null }, "challenge");
  const native = planDaoLaunch(
    challengeInputs({ currency: null, challenge: { bond: 0n, deposit: 0n } }),
  );
  assert.equal(native.challenge.bond, 0n);
  assert.equal(native.challenge.bondToken, ZERO);
  // Nothing to judge, nothing to challenge.
  assert.equal(planDaoLaunch(challengeInputs(NO_TEAM)).challenge, null);
});

test("a challenged launch calls launchChallenged, with the lock's terms, byte for byte as cast encodes them", () => {
  // cast sig "launchChallenged((string,...,uint64),(uint64,uint64,uint64,uint16,address,uint128,uint128))"
  assert.equal(SELECTOR_KIT_LAUNCH_CHALLENGED, "0x5393b15f");
  assert.notEqual(SELECTOR_KIT_LAUNCH_CHALLENGED, SELECTOR_KIT_LAUNCH);
  const executor = "0x4444444444444444444444444444444444444444";
  const data = encodeKitLaunch(planDaoLaunch(challengeInputs()), executor);
  // cast calldata "launchChallenged(<Params>,<ChallengeTerms>)" with this launch's values.
  assert.equal(
    data,
    "0x5393b15f00000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000093a8000000000000000000000000000000000000000000000000000000000000697800000000000000000000000000000000000000000000000000000000000278d00000000000000000000000000000000000000000000000000000000000000012c000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000053444835ec5800000000000000000000000000000000000000000000000000000853a0d2313c0000000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000008ac7230489e800001350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e0000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000004a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000002086ac35105260000000000000000000000000000000000000000000000000000000000000000004c01350e4e5b70395c45379f7881475447181119c3d4b2a238fb7e71a37b9c2437e000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000000000000000000000000000064e6562756c61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000034e454200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000c328093e61ee4000000000000000000000000000000000000000000000000000410d586a20a4c00000000000000000000000000000000000000000000000000000000000000000002584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8e47c52aa8e6c9ea6180a45a06bcb534f0d192a2f1cab93cb6974e060ffea4e2f000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000001388000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000006900000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000002086ac351052600000000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000104c4b4000000000014c4b40000000000100000000000000000000000000000000",
  );
  // The reviewers' panel fields stay empty, and a panel launch still calls launch.
  const panelData = encodeKitLaunch(planDaoLaunch(inputs()), executor);
  assert.ok(panelData.startsWith(SELECTOR_KIT_LAUNCH));
});

test("the receipt records how the milestones are reviewed", () => {
  const plan = planDaoLaunch(challengeInputs());
  const receipt = daoLaunchReceiptContent({
    launched: decodeKitLaunched([launched(KIT)], KIT),
    plan,
    chainId: "31337",
    kit: KIT,
  });
  assert.equal(receipt.panel, undefined);
  assert.deepEqual(receipt.challenge, {
    window: CHALLENGE_DEFAULTS.window,
    votePeriod: CHALLENGE_DEFAULTS.votePeriod,
    clawback: CHALLENGE_DEFAULTS.clawback,
    minRejectBps: CHALLENGE_DEFAULTS.minRejectBps,
    bond: "6000000000000000000",
    deposit: "600000000000000000",
    bondToken: "0x3333333333333333333333333333333333333333",
  });
  const panelReceipt = daoLaunchReceiptContent({
    launched: decodeKitLaunched([launched(KIT)], KIT),
    plan: planDaoLaunch(inputs()),
    chainId: "31337",
    kit: KIT,
  });
  assert.equal(panelReceipt.challenge, undefined);
  assert.ok(panelReceipt.panel);
});
