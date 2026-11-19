// The reads for the allowance, grants, the faucet and a project's parts, against a stand-in node. Run with:
// node --experimental-strip-types --test src/pot/pot-state.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { fakeChain } from "./fake-chain.mjs";
import * as state from "./pot-state.ts";

const TREASURY = "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9";
const VESTER = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";
const ME = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ZERO = "0x0000000000000000000000000000000000000000";

test("the allowance state reads the box, the rate, an announced raise and the clock", async () => {
  const { read } = fakeChain({
    box: [700n],
    boxCap: [7_000n],
    ratePpm: [1000n],
    pendingRatePpm: [2000n],
    pendingAt: [1_800_000_000n],
    lastCheckIn: [1_799_000_000n],
    activeEnd: [1_800_500_000n],
    MAX_RATE_PPM: [2000n],
    unit: [1680n],
  });
  const got = await state.readAllowanceState(read, TREASURY);
  assert.equal(got.box, 700n);
  assert.equal(got.boxCap, 7_000n);
  assert.equal(got.ratePpm, 1000);
  // `pendingAt` is when the raise was announced; the Treasury lets it be applied one time unit later (applyRate reverts
  // NotYet before that), so that is the date read, not the announcement.
  assert.deepEqual(got.pending, {
    ratePpm: 2000,
    applicableAt: 1_800_000_000 + 1680,
  });
  assert.equal(got.lastCheckIn, 1_799_000_000);
  assert.equal(got.activeEnd, 1_800_500_000);
  assert.equal(got.maxRatePpm, 2000);
});

test("the allowance box reads alone, and a short answer throws", async () => {
  const { read } = fakeChain({ box: [700n] });
  assert.equal(await state.boxOf(read, TREASURY), 700n);
  await assert.rejects(() => state.boxOf(async () => "0x", TREASURY));
});

test("a Pair's proposal time limit is read from the Pair", async () => {
  const { read } = fakeChain({ PROPOSAL_TTL: [1_209_600n] });
  assert.equal(await state.proposalTtl(read, ME), 1_209_600);
});

test("the daily rate reads alone", async () => {
  const { read } = fakeChain({ ratePpm: [1000n] });
  assert.equal(await state.ratePpmNow(read, TREASURY), 1000);
});

test("no announced raise reads as none", async () => {
  const { read } = fakeChain({
    box: [0n],
    boxCap: [0n],
    ratePpm: [1000n],
    pendingRatePpm: [0n],
    pendingAt: [0n],
    lastCheckIn: [1n],
    activeEnd: [2n],
    MAX_RATE_PPM: [2000n],
    unit: [1680n],
  });
  assert.equal((await state.readAllowanceState(read, TREASURY)).pending, null);
});

test("a grant is read member, state, amounts and the part to burn", async () => {
  const { read, seen } = fakeChain({
    grantOf: [[ME, false, 1n, 1_800_000_000n, 5000n, 40n, 1_000n, 2500n]],
  });
  const grant = await state.readGrant(read, VESTER, 3n);
  assert.deepEqual(grant, {
    member: ME,
    protectedGrant: false,
    state: 1,
    burnAt: 1_800_000_000,
    total: 5000n,
    claimed: 40n,
    burn: 2500n,
  });
  assert.deepEqual(seen[0].args, [3n]);
});

test("what a grant has built up reads alone", async () => {
  const { read, seen } = fakeChain({ accruedOf: [321n] });
  assert.equal(await state.accruedOf(read, VESTER, 4n), 321n);
  assert.deepEqual(seen[0].args, [4n]);
});

test("the faucet reads its use and its amount", async () => {
  const { read } = fakeChain({
    faucetUsed: [true],
    FAUCET_AMOUNT: [1_000_000_000n],
  });
  assert.equal(await state.faucetUsedBy(read, TREASURY, ME), true);
  assert.equal(await state.faucetAmount(read, TREASURY), 1_000_000_000n);
});

test("a project's parts come from the Launcher, and an unknown key is refused", async () => {
  const parts = [ME, TREASURY, VESTER, TREASURY, VESTER, 1_700_000_000n];
  const { read } = fakeChain({ projectByKey: [[...parts]] });
  const got = await state.readProjectParts(read, ME, `0x${"11".repeat(32)}`);
  assert.equal(got.treasury, TREASURY);
  assert.equal(got.vester, VESTER);
  assert.equal(got.launchedAt, 1_700_000_000);
  const none = fakeChain({
    projectByKey: [[ZERO, ZERO, ZERO, ZERO, ZERO, 0n]],
  });
  await assert.rejects(() =>
    state.readProjectParts(none.read, ME, `0x${"11".repeat(32)}`),
  );
});

test("a short or mistyped answer throws instead of being guessed", async () => {
  const bad = async () => "0x";
  await assert.rejects(() => state.readAllowanceState(bad, TREASURY));
  await assert.rejects(() => state.readGrant(bad, VESTER, 1n));
  const dollar = async () => `0x${"0".repeat(24)}${"ab".repeat(20)}`;
  assert.equal(
    await state.readPlatformDollar(
      async () => `0x${"0".repeat(24)}${"ab".repeat(20)}${"00".repeat(32 * 4)}`,
      ME,
    ),
    `0x${"ab".repeat(20)}`,
  );
  await assert.rejects(() => state.readPlatformDollar(dollar, ME));
});

test("a waiting Pair call reads its proposer and time, and a spent one reads as none", async () => {
  const id = `0x${"22".repeat(32)}`;
  const { read } = fakeChain({ proposer: [ME], proposedAt: [1_800_000_000n] });
  assert.deepEqual(await state.readProposal(read, TREASURY, id), {
    proposer: ME,
    proposedAt: 1_800_000_000,
  });
  const gone = fakeChain({ proposer: [ZERO], proposedAt: [0n] });
  assert.equal(await state.readProposal(gone.read, TREASURY, id), null);
});

const PLATFORM_SELECTOR = "0x4bde38c8";
const word = (value) => value.toString(16).padStart(64, "0");
const addressWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");

test("the launch offer reads the settings hash, the platform's limits and the two ceilings", async () => {
  const chain = fakeChain({
    settingsHash: [`0x${"ab".repeat(32)}`],
    MAX_RATE_PPM: [2000n],
    MAX_TEAM_POOL: [100_000_000n * 10n ** 18n],
    AGENT_SHARE_DIV: [1000n],
    treasuryImpl: [VESTER],
    vesterImpl: [TREASURY],
    MIN_JOIN: [1_000_000n],
    CHECK_IN_MULT: [2n],
    WIND_MULT: [26n],
    CLIFF_MULT: [13n],
    VEST_MULT: [104n],
  });
  // `platform` has five answers on the Launcher and one on the Treasury: the stand-in answers the Launcher's here.
  const platformWords = [
    addressWord(ME),
    addressWord(TREASURY),
    word(200n),
    word(1680n),
    word(25_000_000n),
  ].join("");
  const read = async (to, data) =>
    data === PLATFORM_SELECTOR ? `0x${platformWords}` : chain.read(to, data);
  const got = await state.readLaunchOffer(read, ME);
  assert.deepEqual(got, {
    settingsHash: `0x${"ab".repeat(32)}`,
    dollar: ME,
    feeBps: 200,
    unit: 1680,
    agentUsd: 25_000_000n,
    maxRatePpm: 2000,
    maxTeamPool: 100_000_000n * 10n ** 18n,
    agentShareDiv: 1000n,
    rules: {
      minJoin: 1_000_000n,
      checkInUnits: 2,
      windDownUnits: 26,
      cliffUnits: 13,
      vestUnits: 104,
    },
  });
  await assert.rejects(() => state.readLaunchOffer(async () => "0x", ME));
  const short = fakeChain({ settingsHash: ["0x1234"] });
  await assert.rejects(() =>
    state.readLaunchOffer(
      async (to, data) =>
        data === PLATFORM_SELECTOR
          ? `0x${platformWords}`
          : short.read(to, data),
      ME,
    ),
  );
});

test("the Pair's address is read from the Launcher", async () => {
  const { read, seen } = fakeChain({ pairAddress: [ME] });
  const key = `0x${"11".repeat(32)}`;
  assert.equal(await state.pairAddressOf(read, TREASURY, key, ME, VESTER), ME);
  assert.deepEqual(seen[0].args, [key, ME, VESTER]);
});

test("the seat reads who runs it, an open offer and its length, and the wind-down state", async () => {
  const { read } = fakeChain({
    runner: [ME],
    founder: [ME],
    pendingRunner: [VESTER],
    pendingSeatAt: [1_800_000_000n],
    pendingTrim: [true],
    SEAT_OFFER_MULT: [2n],
    unit: [1680n],
    windDownKind: [0n],
  });
  assert.deepEqual(await state.readSeatState(read, TREASURY), {
    runner: ME,
    founder: ME,
    offeredTo: VESTER,
    offeredAt: 1_800_000_000,
    offerLasts: 3360,
    founderLeaves: true,
    windDownKind: 0,
  });
  const none = fakeChain({
    runner: [ME],
    founder: [ME],
    pendingRunner: [ZERO],
    pendingSeatAt: [0n],
    pendingTrim: [false],
    SEAT_OFFER_MULT: [2n],
    unit: [1680n],
    windDownKind: [2n],
  });
  const got = await state.readSeatState(none.read, TREASURY);
  assert.equal(got.offeredTo, null);
  assert.equal(got.windDownKind, 2);
  await assert.rejects(() => state.readSeatState(async () => "0x", TREASURY));
});
