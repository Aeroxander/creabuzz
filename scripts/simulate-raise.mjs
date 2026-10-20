#!/usr/bin/env node
/**
 * scripts/simulate-raise.mjs — an agent-based simulation of a milestone-locked raise on a real local chain.
 *
 * Boots its own anvil, places the CCA factory and Permit2 at their canonical addresses (as `scripts/dev-chain.sh` does),
 * deploys the Summoner, the DaoLaunchKit and a six-decimal USDC from `contracts/out`, and then:
 *
 *   1. two launches through `DaoLaunchKit.launchChallenged`, encoded by the shared package's own `planDaoLaunch` /
 *      `encodeKitLaunch`: one whose raise is met, one whose raise is not;
 *   2. many accounts bid on both auctions in random orders and amounts (`buildBidCalls`), the sale ends, the raise is
 *      swept to the DAO, and every bidder settles with the web app's own "Your bids and tokens" logic (`my-bids.ts`);
 *   3. thousands of random steps on the launched project: Shares move, holders leave through the web's own exit screen
 *      code (`ragequit-position.ts`), proposals are opened, voted, queued and executed (pay, work budgets, slashes,
 *      forfeits), the team publishes milestones, holders object, vote, resolve and object late, bonds are released, time
 *      passes, and an outsider tries privileged calls.
 *
 * After every step it checks the same invariants as `contracts/test/invariant/MoneyPaths.t.sol`, from the chain:
 *   - the DAO's USDC falls only by an exit (exactly what the exit screen showed) or by a vote that met its bars;
 *   - a team member's balance never falls below what the lock holds back, and a move into it is refused;
 *   - no later milestone is published while an earlier one can still be objected to (D58), and an upheld late objection
 *     burns exactly what is still locked;
 *   - the lock holds exactly the bonds and open deposits, the voting ledger mirrors the Shares, the reviewer panel holds
 *     exactly the bonds, Shares are burned only by exits, forfeits and upheld late objections;
 *   - after the sale: what bidders paid is what the DAO received (plus any dust left in the auction), nobody paid above
 *     their limit, and every bid on the failed raise was refunded in full.
 *
 * Usage: scripts/simulate-raise.sh [--steps 3000] [--seed 7] [--agents 24] [--report target/simulate-raise/report.json]
 * (the .sh wrapper activates the hermit toolchain and builds the contracts first). DEV ONLY: a throwaway local anvil.
 * Whenever a project's milestones are all settled the run launches a fresh one, so a long run covers many launches.
 * SIM_DEBUG=1 prints why refused bids, votes and executions were refused.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak_256 } from "../packages/creaton-core/node_modules/@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "../packages/creaton-core/node_modules/@noble/hashes/utils.js";
import { decodeKitLaunched, encodeKitLaunch, encodeKitPredictExecutor, launchSalt, planDaoLaunch } from "../packages/creaton-core/src/launchpad/daoLaunch.ts";
import { decodeParameters, encodeFunctionData, encodeParameters } from "../packages/creaton-core/src/launchpad/evmAbi.ts";
import { buildBidCalls, encodeExecuteGraduation } from "../packages/creaton-core/src/launchpad/evmContractCalls.ts";
import {
  encodeChallengeFinish,
  encodeChallengeObject,
  encodeChallengeReleaseBond,
  encodeChallengeResolve,
  encodeChallengeSubmit,
  encodeChallengeVote,
} from "../packages/creaton-core/src/launchpad/milestoneChallenge.ts";
import {
  closeBudgetDecision,
  freezeClaimDecision,
  mandateDecision,
  payDecision,
  slashReviewerDecision,
} from "../packages/creaton-core/src/launchpad/daoActions.ts";
import { buildClaimExecution, buildExitExecution, fetchMyBidsSnapshot, resolveExitPlanAt } from "../web/src/features/launchpad/lib/my-bids.ts";
import { deriveClaimablePosition, fetchRagequitPosition } from "../web/src/features/launchpad/lib/ragequit-position.ts";
import { encodeRagequitCalldata } from "../web/src/features/launchpad/lib/ragequit-tx.ts";
import {
  encodeCastVote,
  encodeExecuteByVotes,
  encodeOpenProposalWithAction,
} from "../web/src/features/launchpad/lib/vote-tx.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "contracts", "out");

// ---- options -----------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const STEPS = Number(opt("steps", "3000"));
const SEED = Number(opt("seed", "7"));
const AGENTS = Number(opt("agents", "24"));
const REPORT = opt("report", join(ROOT, "target", "simulate-raise", "report.json"));
const PORT = Number(opt("port", String(19000 + Math.floor(Math.random() * 900))));
const RPC = `http://127.0.0.1:${PORT}`;

// ---- a seeded random source ------------------------------------------------------------------------

let rngState = SEED >>> 0 || 1;
function rand() {
  // mulberry32
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;
const randBig = (lo, hi) => lo + (BigInt(Math.floor(rand() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n;

// ---- chain plumbing ----------------------------------------------------------------------------------

let rpcId = 0;
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) {
    const err = new Error(`${method}: ${body.error.message}`);
    err.data = body.error.data;
    throw err;
  }
  return body.result;
}

/** Several eth_calls in one request. */
async function callMany(calls) {
  if (calls.length === 0) return [];
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      calls.map(([to, data], i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to, data }, "latest"] })),
    ),
  });
  const body = await res.json();
  const byId = new Map(body.map((r) => [r.id, r]));
  return calls.map((_, i) => {
    const r = byId.get(i);
    if (!r || r.error) throw new Error(`eth_call ${calls[i][0]} ${calls[i][1].slice(0, 10)}: ${r?.error?.message}`);
    return r.result;
  });
}

const call = async (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const word = (hex, i = 0) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"}`);
const addr = (hex, i = 0) => `0x${hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`;
const sel = (signature) => `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)}`;
const enc = (signature, types, values) => encodeFunctionData(signature, types, values);
const encAddr = (signature, a) => enc(signature, ["address"], [a]);
const encUint = (signature, n) => enc(signature, ["uint256"], [BigInt(n)]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** Send a transaction from any address (anvil runs with auto-impersonation). Resolves to the receipt. */
const funded = new Set();
async function send(from, to, data, value = 0n) {
  if (!funded.has(from)) {
    await rpc("anvil_setBalance", [from, hex(10n ** 24n)]);
    funded.add(from);
  }
  const tx = { from, data, gas: "0x1c9c380", value: hex(value) };
  if (to) tx.to = to;
  const hash = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 2000; i++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`transaction ${hash} was not mined`);
}
const ok = (receipt) => receipt?.status === "0x1";

async function deploy(artifactPath, ctorTypes = [], ctorValues = []) {
  const artifact = JSON.parse(readFileSync(join(OUT, artifactPath), "utf8"));
  const data = artifact.bytecode.object + (ctorTypes.length ? encodeParameters(ctorTypes, ctorValues).slice(2) : "");
  const receipt = await send(DEPLOYER, null, data);
  if (!ok(receipt)) throw new Error(`deploying ${artifactPath} failed`);
  return receipt.contractAddress;
}

async function now() {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) };
}
async function passTime(seconds) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}
async function mineTo(blockNumber) {
  const { number } = await now();
  if (blockNumber > number) await rpc("anvil_mine", [hex(blockNumber - number)]);
}

// ---- what the run found ------------------------------------------------------------------------------

const counts = {};
const hit = (key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const breaks = [];
let currentStep = "setup";
function broke(invariant, detail) {
  breaks.push({ step: currentStep, invariant, detail });
  console.log(`  !! invariant broken at ${currentStep}: ${invariant} — ${detail}`);
}
let invariantChecks = 0;

// ---- the cast ----------------------------------------------------------------------------------------

const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // anvil dev account 0
const agent = (label) => `0x${bytesToHex(keccak_256(utf8ToBytes(`simulate-raise:${SEED}:${label}`))).slice(24)}`;
const FOUNDER = agent("founder");
const COFOUNDER = agent("cofounder");
const FOUNDER_B = agent("founder-b");
const ATTACKER = agent("attacker");
const BACKERS = Array.from({ length: AGENTS }, (_, i) => agent(`backer-${i}`));
/** Bidders on the raise that misses its target (kept apart so each sale's money can be counted on its own). */
const BIDDERS_B = Array.from({ length: 8 }, (_, i) => agent(`bidder-b-${i}`));
const REVIEWERS = [agent("reviewer-0"), agent("reviewer-1"), agent("reviewer-2")];
const CONTRIBUTOR = agent("contributor");
const CCA_FACTORY = "0x000000001F26a0044BaA66024e7b6599c61963F8";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDC_UNIT = 1_000_000n;

let USDC;

async function usdcBalance(who) {
  return word(await call(USDC, encAddr("balanceOf(address)", who)));
}
async function isBlocked(who) {
  return word(await call(USDC, encAddr("blocked(address)", who))) !== 0n;
}

/** Top an agent up with test USDC; an agent the issuer blocks gets nothing (the test currency refuses it, like USDC). */
async function mintUsdc(to, amount) {
  if (await isBlocked(to)) return;
  if (!ok(await send(DEPLOYER, USDC, enc("mint(address,uint256)", ["address", "uint256"], [to, amount])))) {
    throw new Error("minting USDC failed");
  }
}

// ---- boot ------------------------------------------------------------------------------------------

let anvil;
async function boot() {
  anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "31337", "--auto-impersonate", "--silent", "--gas-limit", "60000000", "--block-base-fee-per-gas", "0", "--prune-history=500"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await rpc("eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`anvil did not start on ${RPC}`);
}
// Thousands of blocks of history would otherwise land in ~/.foundry/anvil/tmp (gigabytes per run, and anvil leaves the
// folder behind whatever signal stops it): `--prune-history=500` keeps the last 500 states in memory and none on disk.
function stopAnvil() {
  if (anvil && !anvil.killed) anvil.kill("SIGINT");
}
process.on("exit", stopAnvil);
process.on("SIGINT", () => {
  stopAnvil();
  process.exit(130);
});

async function deployStack() {
  // The CCA factory and Permit2 at their canonical addresses (bare anvil has neither).
  const factoryArtifact = JSON.parse(
    readFileSync(join(OUT, "ContinuousClearingAuctionFactory.sol", "ContinuousClearingAuctionFactory.json"), "utf8"),
  );
  await rpc("anvil_setCode", [CCA_FACTORY, factoryArtifact.deployedBytecode.object]);
  const permit2 = await deploy("Permit2.sol/Permit2.json");
  await rpc("anvil_setCode", [PERMIT2, await rpc("eth_getCode", [permit2, "latest"])]);

  // The Summoner the way `newSummoner()` makes it: work budget factory, voting policy, summoner.
  const mandateFactory = await deploy("TreasuryMandate.sol/TreasuryMandateFactory.json");
  const policy = await deploy("AllocationVoting.sol/AllocationVoting.json", ["address"], [mandateFactory]);
  const summoner = await deploy("MolochPatched.sol/Summoner.json", ["address"], [policy]);
  const moloch = addr(await call(summoner, sel("getImplementation()")));
  // The Shares implementation the Moloch implementation made for itself: CREATE2 from it, salted with its address.
  const sharesCode = JSON.parse(readFileSync(join(OUT, "MolochPatched.sol", "Shares.json"), "utf8")).bytecode.object;
  const salt = moloch.slice(2).padEnd(64, "0");
  const sharesImpl = `0x${bytesToHex(
    keccak_256(hexToBytes(`ff${moloch.slice(2)}${salt}${bytesToHex(keccak_256(hexToBytes(sharesCode.slice(2))))}`)),
  ).slice(24)}`;
  if ((await rpc("eth_getCode", [sharesImpl, "latest"])) === "0x") throw new Error("Shares implementation not found");
  // The lock factories are deployed beside the kit, which names them.
  const lockFactory = await deploy("MilestoneLockFactory.sol/MilestoneLockFactory.json");
  const challengeFactory = await deploy("MilestoneChallengeFactory.sol/MilestoneChallengeFactory.json");
  const kit = await deploy(
    "DaoLaunchKit.sol/DaoLaunchKit.json",
    ["address", "address", "address", "address", "address"],
    [summoner, CCA_FACTORY, sharesImpl, lockFactory, challengeFactory],
  );
  USDC = await deploy("MoneyPathsHandler.sol/MockUSDC.json");
  return { kit, summoner, mandateFactory };
}

// ---- launching ---------------------------------------------------------------------------------------

/** $0.01 a Share in six-decimal USDC (the terms the challenge journey uses). */
const FLOOR = 792281625140000n;
const TICK = 79228162514n;

async function launch(kit, founder, label, requiredRaisedUsdc, team) {
  const { number } = await now();
  const startBlock = number + 5;
  const endBlock = startBlock + 250;
  const claimBlock = endBlock + 5;
  const plan = planDaoLaunch({
    name: `Sim ${label}`,
    symbol: `SIM${label}`,
    totalSupply: "10000000",
    allocation: { sale: 60, team: 25, dao: 15 },
    team,
    milestones: [
      { check: `${label}: beta live at a public address`, percent: 20 },
      { check: `${label}: first customers are paying`, percent: 30 },
      { check: `${label}: version one released`, percent: 40 },
    ],
    challenge: {},
    proposalThreshold: "0",
    currency: USDC,
    floorPrice: FLOOR.toString(),
    tickSpacing: TICK.toString(),
    requiredRaised: (requiredRaisedUsdc * USDC_UNIT).toString(),
    startBlock,
    endBlock,
    claimBlock,
    salt: launchSalt(`simulate-raise:${SEED}:${label}`),
  });
  const executor = addr(await call(kit, encodeKitPredictExecutor(founder, plan.salt)));
  const receipt = await send(founder, kit, encodeKitLaunch(plan, executor));
  if (!ok(receipt)) throw new Error(`launch ${label} reverted`);
  const launched = decodeKitLaunched(receipt.logs, kit);
  if (!launched) throw new Error(`launch ${label}: no Launched event`);
  const loot = addr(await call(launched.dao, sel("loot()")));
  const policy = addr(await call(launched.dao, sel("votingWeight()")));
  return { ...launched, loot, policy, plan, startBlock, endBlock, claimBlock };
}

// ---- the sale ----------------------------------------------------------------------------------------

/** Every bidder's book on one auction: what they hold before, the bids they placed. */
async function placeBid(p, entry, b) {
  const amount = randBig(200n, 6_000n) * USDC_UNIT;
  // A limit from just above the floor up to four times it, on the tick grid.
  const maxPriceQ96 = FLOOR + BigInt(randInt(1, 30_000)) * TICK;
  const calls = buildBidCalls({
    auction: p.auction,
    currency: USDC,
    plan: { maxPriceQ96, amount, owner: b, prevTickPriceQ96: FLOOR, hookData: "0x" },
    // The currency's allowance to Permit2 covers this bid, or the first call grants it (as the bid form checks).
    needsUnderlyingAllowance:
      word(await call(USDC, enc("allowance(address,address)", ["address", "address"], [b, PERMIT2]))) < amount,
    permit2Deadline: BigInt((await now()).timestamp + 3600),
  });
  let placed = true;
  for (const c of calls) {
    const r = await send(b, c.to, c.data, BigInt(c.value));
    if (!ok(r)) {
      placed = false;
      if (process.env.SIM_DEBUG) {
        try {
          await rpc("eth_call", [{ from: b, to: c.to, data: c.data }, "latest"]);
        } catch (e) {
          console.log("bid refused:", e.message, c.data.slice(0, 10), maxPriceQ96, amount);
        }
      }
    }
  }
  if (placed) {
    entry.bids.push({ amount, maxPriceQ96 });
    if (maxPriceQ96 > entry.maxPrice) entry.maxPrice = maxPriceQ96;
    hit(`sale.bid.${p.plan.symbol}`);
  } else hit(`sale.bidRefused.${p.plan.symbol}`);
}

/**
 * Both sales side by side, block by block (every transaction mines a block, so the loop follows the chain's own block
 * number): in each round some of each sale's bidders bid. Returns every bidder's book per sale.
 */
async function runSales(sales) {
  const books = [];
  for (const { bidders } of sales) {
    const book = new Map();
    for (const b of bidders) {
      if (!books.some((other) => other.has(b))) await mintUsdc(b, 200_000n * USDC_UNIT);
      book.set(b, { before: 0n, bids: [], maxPrice: 0n });
    }
    books.push(book);
  }
  for (const book of books) for (const [b, e] of book) e.before = await usdcBalance(b);
  await mineTo(Math.max(...sales.map((s) => s.p.startBlock)));
  for (;;) {
    const { number } = await now();
    const open = sales.map((s, i) => [s, books[i]]).filter(([s]) => number < s.p.endBlock - 2);
    if (open.length === 0) break;
    currentStep = `sale block ${number}`;
    for (const [{ p, bidders, intensity }, book] of open) {
      const b = pick(bidders);
      if (await isBlocked(b)) continue; // a blocked agent cannot pay for a bid
      if (chance(intensity) && (await now()).number < p.endBlock - 2) await placeBid(p, book.get(b), b);
    }
    await rpc("evm_mine", []);
  }
  await mineTo(Math.max(...sales.map((s) => s.p.endBlock)) + 1);
  return books;
}

/** Settle every bidder through the web's own "Your bids and tokens" logic: exits, then claims after the claim block. */
async function settle(p, book) {
  for (const [b] of book) {
    currentStep = `settle ${p.plan.symbol} exits ${b.slice(0, 8)}`;
    const snap = await fetchMyBidsSnapshot({ endpoint: RPC, auction: p.auction, owner: b });
    for (const entry of snap.bids) {
      const plan = entry.actions.exit;
      if (plan.kind === "unavailable") continue;
      const exec = buildExitExecution({
        auction: p.auction,
        bidId: entry.bidId,
        plan,
        resolvePlan: () => resolveExitPlanAt(RPC, p.auction, entry.bidId),
      });
      for (const step of exec.calls) {
        const tx = await step.build();
        const r = await send(b, tx.to, tx.data, BigInt(tx.value ?? "0x0"));
        hit(ok(r) ? `sale.${step.step}` : `sale.${step.step}Refused`);
      }
    }
  }
  await mineTo(p.claimBlock + 1);
  for (const [b] of book) {
    currentStep = `settle ${p.plan.symbol} claims ${b.slice(0, 8)}`;
    const snap = await fetchMyBidsSnapshot({ endpoint: RPC, auction: p.auction, owner: b });
    const claimable = snap.bids.filter((e) => e.actions.claim.kind === "claim").map((e) => e.bidId);
    if (claimable.length === 0) continue;
    const exec = buildClaimExecution({ auction: p.auction, owner: b, bidIds: claimable });
    for (const step of exec.calls) {
      const tx = await step.build();
      hit(ok(await send(b, tx.to, tx.data)) ? "sale.claim" : "sale.claimRefused");
    }
  }
}

async function checkSale(p, book, graduated) {
  currentStep = `after sale ${p.plan.symbol}`;
  let spent = 0n;
  let tokens = 0n;
  for (const [b, entry] of book) {
    const after = await usdcBalance(b);
    const paid = entry.before - after;
    const got = word(await call(p.shares, encAddr("balanceOf(address)", b)));
    spent += paid;
    tokens += got;
    if (paid < 0n) broke("sale: a bidder got back more than they paid", `${b} ${paid}`);
    if (!graduated) {
      if (paid !== 0n) broke("failed raise: a bid was not refunded in full", `${b} kept ${paid}`);
      if (got !== 0n) broke("failed raise: a bidder received Shares", `${b} ${got}`);
      continue;
    }
    // Nobody pays above their own highest limit (price in Q96 per base unit of Shares).
    if (got > 0n && paid * 2n ** 96n > got * entry.maxPrice + 2n ** 96n) {
      broke("sale: a bidder paid above their limit", `${b} paid ${paid} for ${got}`);
    }
    if (got === 0n && paid !== 0n) broke("sale: a bidder paid and received nothing", `${b} paid ${paid}`);
  }
  const daoUsdc = await usdcBalance(p.dao);
  const left = await usdcBalance(p.auction);
  if (graduated) {
    if (spent !== daoUsdc + left) broke("sale: bidders paid other than the DAO received", `paid ${spent} dao ${daoUsdc} left ${left}`);
    if (left > 1_000n) broke("sale: more than dust left in the auction", `${left}`);
    if (tokens > p.saleSupply) broke("sale: more Shares claimed than were sold", `${tokens} > ${p.saleSupply}`);
  } else if (left !== 0n || daoUsdc !== 0n) {
    broke("failed raise: money stayed behind", `auction ${left} dao ${daoUsdc}`);
  }
  console.log(
    `  ${p.plan.symbol}: ${graduated ? "raise met" : "raise missed"}; bidders paid ${spent / USDC_UNIT} USDC, ` +
      `DAO holds ${daoUsdc / USDC_UNIT}, ${left} base units left in the auction, ${tokens / 10n ** 18n} Shares claimed, ` +
      `${word(await call(p.shares, S.balanceOf(p.auction)))} Share base units left in the auction`,
  );
}

// ---- the project after the sale ------------------------------------------------------------------------

const S = {
  balanceOf: (a) => encAddr("balanceOf(address)", a),
  totalSupply: sel("totalSupply()"),
  lockedOf: (a) => encAddr("lockedOf(address)", a),
  milestone: (i) => encUint("milestone(uint256)", i),
  objection: (i) => encUint("objection(uint256)", i),
};

let P; // the launched project the steps act on
let lockState; // { count, team, clawback, minRejectBps }
const proposals = [];
let mandate = null;

async function readMilestones() {
  const calls = [];
  for (let i = 0; i < lockState.count; i++) calls.push([P.lock, S.milestone(i)], [P.lock, S.objection(i)]);
  const res = await callMany(calls);
  const out = [];
  for (let i = 0; i < lockState.count; i++) {
    const m = res[2 * i];
    const o = res[2 * i + 1];
    out.push({
      phase: Number(word(m, 0)),
      lateObjected: word(m, 1) !== 0n,
      windowEnds: word(m, 5),
      unlockedAt: word(m, 6),
      bond: word(m, 7),
      open: word(o, 0) !== 0n,
      late: word(o, 1) !== 0n,
      voteEnds: word(o, 4),
      deposit: word(o, 5),
      eligible: word(o, 6),
      reject: word(o, 7),
      accept: word(o, 8),
    });
  }
  return out;
}

async function holders() {
  // Everyone who holds Shares (never empty: the team keeps its locked Shares unless they are forfeited).
  const everyone = [...lockState.team, ...BACKERS, CONTRIBUTOR, ATTACKER];
  const bal = await callMany(everyone.map((a) => [P.shares, S.balanceOf(a)]));
  return everyone.filter((_, i) => word(bal[i]) > 0n);
}

/** The invariants, read from the chain after every step. */
async function checkInvariants(expect) {
  invariantChecks++;
  const team = lockState.team;
  const reads = [
    ...team.map((m) => [P.shares, S.balanceOf(m)]),
    ...team.map((m) => [P.lock, S.lockedOf(m)]),
    [USDC, S.balanceOf(P.lock)],
    [P.policy, sel("totalCapacity()")],
    [P.shares, S.totalSupply],
    [USDC, S.balanceOf(P.dao)],
  ];
  const r = await callMany(reads);
  const n = team.length;
  for (let i = 0; i < n; i++) {
    if (word(r[i]) < word(r[n + i])) broke("locked Shares left their holder", `${team[i]} ${word(r[i])} < ${word(r[n + i])}`);
  }
  const lockUsdc = word(r[2 * n]);
  const capacity = word(r[2 * n + 1]);
  const supply = word(r[2 * n + 2]);
  const daoUsdc = word(r[2 * n + 3]);
  if (capacity !== supply) broke("voting ledger lost track of the Shares", `${capacity} != ${supply}`);

  const ms = await readMilestones();
  let owed = 0n;
  const ts = BigInt((await now()).timestamp);
  for (let k = 0; k < ms.length; k++) {
    owed += ms[k].bond + (ms[k].open ? ms[k].deposit : 0n);
    const exposed = ms[k].open || (ms[k].phase === 3 && !ms[k].lateObjected && ts < ms[k].unlockedAt + lockState.clawback);
    if (!exposed) continue;
    for (let j = k + 1; j < ms.length; j++) {
      if (ms[j].phase !== 0) broke("D58: a later milestone moved while an earlier could be objected to", `k=${k} j=${j}`);
    }
  }
  // What settling a vote could not pay a blocked payee waits in the lock too (D67).
  const payees = [...team, ...BACKERS, CONTRIBUTOR, ATTACKER, P.dao];
  for (const h of await callMany(payees.map((a) => [P.lock, encAddr("owed(address)", a)]))) owed += word(h);
  if (lockUsdc !== owed) broke("the lock holds other than its bonds, open deposits and what it owes", `${lockUsdc} != ${owed}`);

  // Money out of the DAO: only an exit (exactly the preview) or an executed vote that met its bars.
  const out = expect.daoUsdcBefore - daoUsdc;
  if (out > 0n && out !== expect.allowedOut) broke("USDC left the DAO without a vote or an exit", `out ${out}, allowed ${expect.allowedOut}`);
  // Shares are only ever burned by exits, forfeits and upheld late objections, never minted after the sale.
  if (supply > expect.supplyBefore) broke("Shares were minted after the sale", `${expect.supplyBefore} -> ${supply}`);
  if (supply < expect.supplyBefore && !expect.burnAllowed) broke("Shares were burned outside an exit or a forfeit", `${expect.supplyBefore} -> ${supply}`);

  if (mandate) {
    const panelReads = REVIEWERS.flatMap((rv) => [
      [mandate.panel, encAddr("verifiers(address)", rv)],
      [mandate.panel, encAddr("unbonds(address)", rv)],
    ]);
    const pr = await callMany([...panelReads, [USDC, S.balanceOf(mandate.panel)]]);
    let held = 0n;
    for (let i = 0; i < REVIEWERS.length; i++) held += word(pr[2 * i], 1) + word(pr[2 * i + 1], 0);
    if (word(pr[pr.length - 1]) !== held) broke("the reviewer panel holds other than the bonds", `${word(pr[pr.length - 1])} != ${held}`);
  }
}

// ---- proposals -----------------------------------------------------------------------------------

/** The bars, checked from the policy's raw numbers rather than the governor's own `state` (as the Forge handler does). */
async function passing(id, atTimestamp) {
  const [rules, support, snapHex, queuedHex] = await callMany([
    [P.policy, encUint("proposals(uint256)", id)],
    [P.policy, encUint("proposalSupport(uint256)", id)],
    [P.dao, encUint("snapshotBlock(uint256)", id)],
    [P.dao, encUint("queuedAt(uint256)", id)],
  ]);
  const [votingSupply, quorum, minYes, approvalBps, reviewEndsAt, expiresAt, delay, hold, bounded] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
    word(rules, i),
  );
  const [yes, no, abstain, since] = [0, 1, 2, 3].map((i) => word(support, i));
  const snap = word(snapHex);
  const queued = word(queuedHex);
  if (expiresAt === 0n) return false;
  // Voting supply: everything at the snapshot less what can never vote, the DAO's own Shares and every holder the
  // policy excludes (the burn address and, since D69, the auction holding unclaimed Shares).
  const excluded = decodeParameters([{ array: "address" }], await call(P.policy, sel("excludedHolders()")))[0];
  const [total, daoCap, ...excludedCaps] = await callMany([
    [P.shares, encUint("getPastTotalSupply(uint48)", snap)],
    [P.policy, enc("getPastCapacity(address,uint48)", ["address", "uint48"], [P.dao, snap])],
    ...excluded.map((a) => [P.policy, enc("getPastCapacity(address,uint48)", ["address", "uint48"], [a, snap])]),
  ]);
  const expectSupply = excludedCaps.reduce((acc, h) => acc - word(h), word(total) - word(daoCap));
  const laneQuorum = (expectSupply * (bounded ? 1000n : 2000n) + 9999n) / 10000n;
  const t = BigInt(atTimestamp);
  const earliest = since + hold > reviewEndsAt ? since + hold : reviewEndsAt;
  return (
    votingSupply === expectSupply &&
    quorum >= laneQuorum &&
    approvalBps >= (bounded ? 5500n : 6600n) &&
    delay >= 86400n &&
    since !== 0n &&
    t >= earliest &&
    t < expiresAt &&
    yes + no + abstain >= quorum &&
    yes >= minYes &&
    yes > no &&
    yes * 10000n >= approvalBps * (yes + no) &&
    queued !== 0n &&
    t >= queued + delay
  );
}

async function propose(draft, kind, outflow) {
  const who = pick(await holders());
  if (!who) return;
  const intent = { op: 0, to: draft.to, value: 0n, data: draft.data, nonce: `0x${bytesToHex(keccak_256(utf8ToBytes(`nonce:${proposals.length}:${SEED}`)))}` };
  const r = await send(who, P.dao, encodeOpenProposalWithAction(intent));
  if (!ok(r)) {
    hit("govern.openRefused");
    return;
  }
  const id = word(await call(P.dao, enc("proposalId(uint8,address,uint256,bytes,bytes32)", ["uint8", "address", "uint256", "bytes", "bytes32"], [0n, intent.to, 0n, intent.data, intent.nonce])));
  // Most proposals have a mood: the holders mostly back it, or mostly do not.
  // Most proposals have a clear mood; a work budget is something the holders usually want.
  const mood = kind === "mandate" || chance(0.6) ? 0.85 + rand() * 0.15 : rand();
  proposals.push({ id, intent, kind, outflow, mood, executed: false });
  hit(`govern.open.${kind}`);
}

// ---- the steps -----------------------------------------------------------------------------------

async function stepTransfer(expect) {
  const from = pick(await holders());
  const to = pick([...BACKERS, CONTRIBUTOR, ATTACKER, ...lockState.team].filter((a) => a !== from));
  const [balHex, lockedHex] = await callMany([[P.shares, S.balanceOf(from)], [P.lock, S.lockedOf(from)]]);
  const balance = word(balHex);
  const locked = word(lockedHex);
  const free = locked >= balance ? 0n : balance - locked;
  const amount = chance(0.3) && locked > 0n ? free + randBig(1n, locked) : randBig(0n, balance);
  const r = await send(from, P.shares, enc("transfer(address,uint256)", ["address", "uint256"], [to, amount]));
  if (ok(r) && amount > free) broke("locked Shares moved", `${from} moved ${amount} with ${free} free`);
  if (!ok(r) && amount <= free) broke("free Shares could not be moved", `${from} ${amount} <= ${free}`);
  hit(ok(r) ? "transfer" : "transfer.refusedLocked");
}

async function stepExit(expect) {
  const who = pick(await holders());
  // The exit screen's own reads and arithmetic.
  const position = await fetchRagequitPosition(RPC, P.dao, who, [USDC]);
  if (!position.ragequittable || position.sharesBurnable === 0n) {
    if (position.sharesLocked > 0n) {
      const r = await send(who, P.dao, encodeRagequitCalldata({ tokens: [USDC], sharesToBurn: position.sharesBurnable + 1n, lootToBurn: 0n }));
      if (ok(r)) broke("locked Shares were ragequit", `${who}`);
      hit("exit.refusedLocked");
    }
    return;
  }
  // Usually the screen's full exit; sometimes part of it, priced with the same function.
  const sharesToBurn = chance(0.4) ? position.sharesBurnable : randBig(1n, position.sharesBurnable);
  const rows = deriveClaimablePosition({
    sharesToBurn,
    lootToBurn: 0n,
    sharesBalance: position.sharesBalance,
    lootBalance: position.lootBalance,
    sharesTotal: position.sharesTotal,
    lootTotal: position.lootTotal,
    daoHeld: position.daoHeld,
    lockedTotal: position.lockedTotal,
    pools: position.rows.map((row) => ({ token: row.token, pool: row.pool })),
  });
  const due = rows[0].due;
  expect.allowedOut = due;
  expect.burnAllowed = true;
  const before = await usdcBalance(who);
  const r = await send(who, P.dao, encodeRagequitCalldata({ tokens: [USDC], sharesToBurn, lootToBurn: 0n }));
  if (!ok(r)) {
    // A holder the currency's issuer blocks cannot be paid, so their exit fails; anyone else's must go through.
    const blocked = await isBlocked(who);
    if (!(blocked && due !== 0n)) broke("an exit the screen offered was refused", `${who} ${sharesToBurn}`);
    hit("exit.refusedBlocked");
    return;
  }
  const got = (await usdcBalance(who)) - before;
  if (got !== due) broke("exit paid other than the screen showed", `${who} got ${got}, screen ${due}`);
  hit(lockState.team.includes(who) ? "exit.team" : "exit");
}

async function stepPropose() {
  const kinds = ["pay", "pay", "payAttacker", "forfeit", "mandate", "slash", "freeze", "close"];
  const kind = pick(kinds);
  const daoUsdc = await usdcBalance(P.dao);
  if (kind === "pay" || kind === "payAttacker") {
    if (daoUsdc === 0n) return;
    const amount = randBig(1n, daoUsdc / 4n + 1n);
    const recipient = kind === "pay" ? pick(BACKERS) : ATTACKER;
    await propose(payDecision({ currency: USDC, currencyDecimals: 6, currencySymbol: "USDC", recipient, amount }), kind, amount);
  } else if (kind === "forfeit") {
    const who = pick(lockState.team);
    await propose({ to: P.lock, data: encAddr("forfeit(address)", who) }, kind, 0n);
  } else if (kind === "mandate") {
    if (mandate || daoUsdc < 20_000n * USDC_UNIT) return;
    const ts = (await now()).timestamp;
    const draft = mandateDecision({
      dao: P.dao,
      factory: P.mandateFactory,
      currency: USDC,
      currencyDecimals: 6,
      budget: 10_000n * USDC_UNIT,
      cap: 5_000n * USDC_UNIT,
      shareBudget: 0n,
      shareCap: 0n,
      expiresAt: ts + 400 * 86400,
      reviewers: REVIEWERS,
      quorum: 2,
      reviewerBond: 500n * USDC_UNIT,
      now: ts,
    });
    await propose(draft, kind, 10_000n * USDC_UNIT);
  } else if (mandate && kind === "slash") {
    const reviewer = pick(REVIEWERS);
    await propose(
      slashReviewerDecision({ mandate: mandate.address, reviewer, amount: randBig(1n, 1_500n * USDC_UNIT), bondDecimals: 6, bondSymbol: "USDC" }),
      kind,
      0n,
    );
  } else if (mandate && kind === "freeze" && mandate.claims.length > 0) {
    await propose(freezeClaimDecision({ mandate: mandate.address, claimId: pick(mandate.claims) }), kind, 0n);
  } else if (mandate && kind === "close") {
    await propose(closeBudgetDecision({ mandate: mandate.address }), kind, 0n);
  }
}

/** Proposals not executed and not past their expiry (people do not vote on dead proposals; a few still try to run one). */
async function liveProposals() {
  const pending = proposals.filter((p) => !p.executed);
  if (pending.length === 0) return [];
  const expiries = await callMany(pending.map((p) => [P.policy, encUint("expiryOf(uint256)", p.id)]));
  const t = BigInt((await now()).timestamp);
  return pending.filter((_, i) => word(expiries[i]) > t);
}

async function stepVote() {
  const live = await liveProposals();
  if (live.length === 0) return;
  const prop = pick(live);
  // A handful of holders turn up together (the team among them), leaning the way this proposal's holders lean.
  const voters = [...lockState.team, ...(await holders())];
  for (let i = randInt(3, 10); i > 0; i--) {
    const who = pick(voters);
    const side = rand() < prop.mood ? 1 : pick([0, 0, 2, 1]);
    const amount = chance(0.8) ? (1n << 256n) - 1n : randBig(1n, word(await call(P.policy, encAddr("capacity(address)", who))) + 1n);
    const r = await send(who, P.dao, encodeCastVote(prop.id, side, amount));
    hit(ok(r) ? "govern.vote" : "govern.voteRefused");
    if (!ok(r) && process.env.SIM_DEBUG) {
      try {
        await rpc("eth_call", [{ from: who, to: P.dao, data: encodeCastVote(prop.id, side, amount) }, "latest"]);
      } catch (e) {
        console.log("vote refused", e.message.slice(0, 80), side, amount === (1n << 256n) - 1n ? "max" : "some");
      }
    }
  }
}

async function stepExecute(expect) {
  const live = chance(0.9) ? await liveProposals() : proposals.filter((p) => !p.executed);
  if (live.length === 0) return;
  // People come back to run what they queued a day ago more often than they try something at random.
  const queued = (await callMany(live.map((p) => [P.dao, encUint("queuedAt(uint256)", p.id)]))).map((h) => word(h) !== 0n);
  const waiting = live.filter((_, i) => queued[i]);
  const prop = waiting.length && chance(0.7) ? pick(waiting) : pick(live);
  const caller = pick([...BACKERS, ATTACKER]);
  const ts = (await now()).timestamp;
  const queuedBefore = word(await call(P.dao, encUint("queuedAt(uint256)", prop.id)));
  // Whether it can run in the next block (the transaction's own timestamp is at least one second later).
  const willPass = await passing(prop.id, ts + 1);
  if (prop.kind === "pay" || prop.kind === "payAttacker" || prop.kind === "mandate") expect.allowedOut = prop.outflow;
  if (prop.kind === "forfeit") expect.burnAllowed = true;
  const forfeited = prop.kind === "forfeit" ? addr(`0x${prop.intent.data.slice(10)}`) : null;
  const lockedBefore = forfeited ? word(await call(P.lock, S.lockedOf(forfeited))) : 0n;
  const r = await send(caller, P.dao, encodeExecuteByVotes(prop.intent));
  const executed = word(await call(P.dao, encUint("executed(uint256)", prop.id))) !== 0n;
  if (!ok(r)) {
    hit("govern.executeRefused");
    if (process.env.SIM_DEBUG) {
      const [st, sup, rules] = await callMany([
        [P.dao, encUint("state(uint256)", prop.id)],
        [P.policy, encUint("proposalSupport(uint256)", prop.id)],
        [P.policy, encUint("proposals(uint256)", prop.id)],
      ]);
      console.log(`execute refused ${prop.kind}: state ${word(st)} yes ${word(sup, 0)} no ${word(sup, 1)} abstain ${word(sup, 2)} since ${word(sup, 3)} supply ${word(rules, 0)} quorum ${word(rules, 1)}`);
    }
    return;
  }
  if (!executed) {
    hit(queuedBefore === 0n ? "govern.queued" : "govern.requeued");
    return;
  }
  const block = await rpc("eth_getBlockByNumber", [r.blockNumber, false]);
  if (!willPass && !(await passing(prop.id, Number(BigInt(block.timestamp))))) {
    broke("a proposal executed without meeting its bars", `${prop.kind} ${hex(prop.id)}`);
  }
  prop.executed = true;
  hit(`govern.executed.${prop.kind}`);
  if (forfeited) {
    if (word(await call(P.lock, S.lockedOf(forfeited))) !== 0n) broke("a forfeit left Shares locked", forfeited);
    if (expect.supplyBefore - word(await call(P.shares, S.totalSupply)) !== lockedBefore) {
      broke("a forfeit burned other than the locked Shares", forfeited);
    }
  }
  if (prop.kind === "mandate" && !mandate) await adoptMandate(r);
}

async function adoptMandate(receipt) {
  const topic = `0x${bytesToHex(keccak_256(utf8ToBytes("MandateCreated(address,address,address,uint128,uint128,uint128,uint128)")))}`;
  const log = receipt.logs.find((l) => l.topics[0] === topic);
  if (!log) return;
  const address = addr(log.topics[2]);
  const panel = addr(await call(address, sel("verifiers()")));
  const claims = addr(await call(address, sel("claims()")));
  mandate = { address, panel, claimStake: claims, claims: [] };
  for (const rv of REVIEWERS) {
    await mintUsdc(rv, 5_000n * USDC_UNIT);
    await send(rv, USDC, enc("approve(address,uint256)", ["address", "uint256"], [panel, (1n << 256n) - 1n]));
    await send(rv, panel, encUint("bond(uint256)", 500n * USDC_UNIT));
  }
  hit("work.budgetCreated");
}

async function stepReviewerBond(expect) {
  if (!mandate) return;
  const rv = pick(REVIEWERS);
  const choice = randInt(0, 2);
  if (choice === 0) hit(ok(await send(rv, mandate.panel, encUint("bond(uint256)", randBig(1n, 800n) * USDC_UNIT))) ? "bond.post" : "bond.refused");
  else if (choice === 1) {
    const stake = word(await call(mandate.panel, encAddr("verifiers(address)", rv)), 1);
    if (stake > 0n) hit(ok(await send(rv, mandate.panel, encUint("requestUnbond(uint256)", randBig(1n, stake)))) ? "bond.requestBack" : "bond.refused");
  } else {
    const u = await call(mandate.panel, encAddr("unbonds(address)", rv));
    const before = await usdcBalance(rv);
    const r = await send(rv, mandate.panel, sel("withdraw()"));
    if (ok(r)) {
      if (BigInt((await now()).timestamp) < word(u, 1)) broke("a bond was taken back before the wait", rv);
      if ((await usdcBalance(rv)) - before !== word(u, 0)) broke("a bond withdrawal paid other than what was pending", rv);
      hit("bond.withdraw");
    }
  }
}

/** How the holders lean on each open objection (0: they back the team, 1: they back the objector). */
const objectionMood = new Map();

async function msSubmit(k) {
  const who = pick(lockState.team);
  const evidence = `0x${bytesToHex(keccak_256(utf8ToBytes(`evidence:${k}:${rand()}`)))}`;
  // The bond is in the sale currency: fund and approve it the way the web's submit flow does.
  await mintUsdc(who, 10_000n * USDC_UNIT);
  await send(who, USDC, enc("approve(address,uint256)", ["address", "uint256"], [P.lock, (1n << 256n) - 1n]));
  hit(ok(await send(who, P.lock, encodeChallengeSubmit(k, evidence))) ? "milestone.submit" : "milestone.submitRefused");
}

async function msObject(k, phase) {
  const who = chance(0.1) ? pick(lockState.team) : pick(await holders());
  await mintUsdc(who, 1_000n * USDC_UNIT);
  await send(who, USDC, enc("approve(address,uint256)", ["address", "uint256"], [P.lock, (1n << 256n) - 1n]));
  const r = await send(who, P.lock, encodeChallengeObject(k));
  if (ok(r) && lockState.team.includes(who)) broke("a team member objected to their own milestone", who);
  // Most objections find little support; some find a lot.
  if (ok(r)) objectionMood.set(k, chance(0.7) ? rand() * 0.3 : 0.6 + rand() * 0.4);
  hit(ok(r) ? (phase === 3 ? "milestone.objectLate" : "milestone.object") : "milestone.objectRefused");
}

async function msVote(k, m) {
  // A few holders turn up at once, leaning the way this objection's holders lean.
  for (let i = randInt(1, 5); i > 0; i--) {
    const who = pick(await holders());
    const before = (await readMilestones())[k];
    const weight = word(await call(P.lock, enc("voteWeight(uint256,address)", ["uint256", "address"], [BigInt(k), who])));
    const r = await send(who, P.lock, encodeChallengeVote(k, rand() < (objectionMood.get(k) ?? 0.5)));
    if (!ok(r)) {
      hit("milestone.voteRefused");
      continue;
    }
    // D57: what counts is the smaller of the Shares owned before the objection and the Shares held now.
    const after = (await readMilestones())[k];
    if (after.reject + after.accept - (before.reject + before.accept) !== weight) broke("a milestone vote counted other than its weight", who);
    if (lockState.team.includes(who)) broke("a team member voted on their own milestone", who);
    hit("milestone.vote");
  }
}

async function msResolve(k, m, expect) {
  const t = BigInt((await now()).timestamp);
  if (t < m.voteEnds) await passTime(Number(m.voteEnds - t) + 1);
  const upheld = m.reject > m.accept && m.reject * 10000n >= m.eligible * lockState.minRejectBps;
  const team = lockState.team;
  const lockedBefore = (await callMany(team.map((a) => [P.lock, S.lockedOf(a)]))).reduce((a, h) => a + word(h), 0n);
  const supplyBefore = word(await call(P.shares, S.totalSupply));
  expect.burnAllowed = m.late && upheld;
  expect.supplyBefore = supplyBefore;
  const r = await send(pick(BACKERS), P.lock, encodeChallengeResolve(k));
  if (!ok(r)) {
    // msResolve waits out the vote first, so a refusal here means an ended vote could not be settled.
    broke("a vote that had ended could not be settled", `milestone ${k}`);
    return;
  }
  const burned = supplyBefore - word(await call(P.shares, S.totalSupply));
  if (m.late && upheld) {
    if (burned !== lockedBefore) broke("an upheld late objection burned other than what was locked", `${burned} != ${lockedBefore}`);
    if (k + 1 < lockState.count && burned === 0n) {
      const ahead = await callMany(team.map((a) => [P.lock, enc("trancheOf(address,uint256)", ["address", "uint256"], [a, BigInt(k + 1)])]));
      if (ahead.some((tr) => word(tr, 3) === 0n)) broke("D58: an upheld late objection had nothing to burn", `milestone ${k}`);
    }
    hit(burned === 0n ? "milestone.lateUpheldEmpty" : "milestone.lateUpheld");
  } else {
    if (burned !== 0n) broke("an objection burned Shares without a late upheld vote", `${burned}`);
    hit(m.late ? "milestone.lateFailed" : upheld ? "milestone.upheld" : "milestone.objectionFailed");
  }
}

/**
 * The team, the holders and passers-by act on the milestones the way people would: the team publishes the next one when
 * it may, holders sometimes object (within the window, or late within the month), vote, and anyone settles a vote or
 * finishes a milestone once its time is up. One step in seven does something at random instead, to try the odd orders.
 */
async function stepMilestone(expect) {
  const ms = await readMilestones();
  const t = BigInt((await now()).timestamp);
  if (chance(1 / 7)) {
    const k = randInt(0, ms.length - 1);
    const what = randInt(0, 5);
    if (what === 0) await msSubmit(k);
    else if (what === 1) await msObject(k, ms[k].phase);
    else if (what === 2 && ms[k].open) await msVote(k, ms[k]);
    else if (what === 3 && ms[k].open) await msResolve(k, ms[k], expect);
    else if (what === 4) hit(ok(await send(pick(BACKERS), P.lock, encodeChallengeFinish(k))) ? "milestone.finish" : "milestone.finishRefused");
    else hit(ok(await send(pick(lockState.team), P.lock, encodeChallengeReleaseBond(k))) ? "milestone.releaseBond" : "milestone.releaseRefused");
    return;
  }
  const open = ms.findIndex((m) => m.open);
  if (open >= 0) {
    if (t >= ms[open].voteEnds || chance(0.25)) await msResolve(open, ms[open], expect);
    else await msVote(open, ms[open]);
    return;
  }
  // A bond whose month is over goes back to the team.
  const bonded = ms.findIndex((m) => m.phase === 3 && m.bond > 0n && t >= m.unlockedAt + lockState.clawback);
  if (bonded >= 0 && chance(0.5)) {
    hit(ok(await send(pick(lockState.team), P.lock, encodeChallengeReleaseBond(bonded))) ? "milestone.releaseBond" : "milestone.releaseRefused");
    return;
  }
  const next = ms.findIndex((m) => m.phase !== 3);
  const last = next < 0 ? ms.length - 1 : next - 1;
  // Late objections: within the month after the newest unlock.
  if (last >= 0 && !ms[last].lateObjected && t < ms[last].unlockedAt + lockState.clawback && chance(0.2)) {
    await msObject(last, 3);
    return;
  }
  if (next < 0) return;
  const m = ms[next];
  if (m.phase === 0) await msSubmit(next);
  else if (m.phase === 1) {
    if (t >= m.windowEnds) hit(ok(await send(pick(BACKERS), P.lock, encodeChallengeFinish(next))) ? "milestone.finish" : "milestone.finishRefused");
    else if (chance(0.15)) await msObject(next, 1);
  }
}

async function stepWork(expect) {
  if (!mandate) return;
  const choice = randInt(0, 3);
  if (choice === 0) {
    const claimId = `0x${bytesToHex(keccak_256(utf8ToBytes(`claim:${mandate.claims.length}:${SEED}`)))}`;
    const r = await send(CONTRIBUTOR, mandate.claimStake, enc("submitClaim(bytes32,uint256,uint256,bytes32)", ["bytes32", "uint256", "uint256", "bytes32"], [claimId, 0n, 0n, claimId]));
    if (ok(r)) {
      mandate.claims.push(claimId);
      hit("work.claim");
    }
  } else if (choice === 1 && mandate.claims.length) {
    const r = await send(pick(REVIEWERS), mandate.panel, enc("attest(bytes32,bool)", ["bytes32", "bool"], [pick(mandate.claims), chance(0.8)]));
    hit(ok(r) ? "work.attest" : "work.attestRefused");
  } else if (choice === 2 && mandate.claims.length) {
    hit(ok(await send(pick(BACKERS), mandate.claimStake, enc("settle(bytes32)", ["bytes32"], [pick(mandate.claims)]))) ? "work.settle" : "work.settleRefused");
  } else if (choice === 3) {
    expect.allowedOut = 0n;
    const r = await send(pick(BACKERS), mandate.address, sel("returnUnused()"));
    hit(ok(r) ? "work.returnUnused" : "work.returnRefused");
  }
}

async function stepAttack() {
  const doors = [
    [P.dao, enc("spendAllowance(address,uint256)", ["address", "uint256"], [USDC, 1n])],
    [P.dao, enc("setAllowance(address,address,uint256)", ["address", "address", "uint256"], [ATTACKER, USDC, 1n << 100n])],
    [P.dao, enc("setRagequittable(bool)", ["bool"], [false])],
    [P.shares, enc("burnForfeited(address,uint256)", ["address", "uint256"], [lockState.team[0], 1n])],
    [P.shares, enc("mintFromMoloch(address,uint256)", ["address", "uint256"], [ATTACKER, 10n ** 24n])],
    [P.shares, encAddr("setLockGuard(address)", "0x0000000000000000000000000000000000000000")],
    [P.lock, encAddr("forfeit(address)", lockState.team[0])],
    [USDC, enc("transferFrom(address,address,uint256)", ["address", "address", "uint256"], [P.dao, ATTACKER, 1n])],
    [P.dao, encodeExecuteByVotes({ op: 0, to: USDC, value: 0n, data: enc("transfer(address,uint256)", ["address", "uint256"], [ATTACKER, 1n]), nonce: `0x${"ab".repeat(32)}` })],
  ];
  if (mandate) {
    doors.push([mandate.address, sel("close()")]);
    doors.push([mandate.panel, enc("slash(address,uint256)", ["address", "uint256"], [REVIEWERS[0], 1n])]);
    doors.push([mandate.address, enc("slashReviewer(address,uint256)", ["address", "uint256"], [REVIEWERS[0], 1n])]);
  }
  const [to, data] = pick(doors);
  const who = chance(0.5) ? ATTACKER : pick(await holders());
  if (ok(await send(who, to, data))) broke("a privileged door opened for an outsider", `${to} ${data.slice(0, 10)}`);
  hit("attack.refused");
}

/** The currency's issuer blocks or unblocks a holder (as USDC's can), and blocked payees come back for what they are owed. */
async function stepIssuer() {
  const who = pick([...(await holders()), CONTRIBUTOR]);
  if (chance(0.5)) {
    const on = chance(0.5);
    await send(DEPLOYER, USDC, enc("setBlocked(address,bool)", ["address", "bool"], [who, on]));
    hit(on ? "issuer.block" : "issuer.unblock");
    return;
  }
  const owed = word(await call(P.lock, encAddr("owed(address)", who)));
  const before = await usdcBalance(who);
  const r = await send(who, P.lock, sel("withdrawOwed()"));
  if (ok(r) && (await usdcBalance(who)) - before !== owed) broke("withdrawOwed paid other than what was owed", who);
  const blocked = await isBlocked(who);
  if (!ok(r) && !blocked) broke("an unblocked payee could not take what was owed", who);
  if (ok(r) && owed > 0n) hit("lock.withdrawOwed");
}

async function stepTime() {
  await passTime(randInt(3600, 5 * 86400));
  hit("time");
}

// ---- one project after another -----------------------------------------------------------------------

let KIT;
let MANDATE_FACTORY;

/** Make `project` the one the steps act on. */
async function adopt(project) {
  P = project;
  // D69: Shares waiting in the auction for their buyers are outside the voting supply from the DAO's birth.
  const auctionExcluded = word(await call(P.policy, encAddr("isExcluded(address)", P.auction))) !== 0n;
  if (!auctionExcluded) broke("the auction is not outside the voting supply", P.auction);
  const [countHex, teamHex, clawHex, rejectHex] = await callMany([
    [P.lock, sel("milestoneCount()")],
    [P.lock, sel("team()")],
    [P.lock, sel("clawback()")],
    [P.lock, sel("minRejectBps()")],
  ]);
  lockState = {
    count: Number(word(countHex)),
    team: decodeParameters([{ array: "address" }], teamHex)[0].map((a) => a.toLowerCase()),
    clawback: word(clawHex),
    minRejectBps: word(rejectHex),
  };
  proposals.length = 0;
  mandate = null;
  objectionMood.clear();
}

/** Nothing is locked any more and no objection is open: every milestone stood, was burned, or was given up. */
async function scheduleOver() {
  const locked = await callMany(lockState.team.map((m) => [P.lock, S.lockedOf(m)]));
  if (locked.some((h) => word(h) !== 0n)) return false;
  return !(await readMilestones()).some((m) => m.open);
}

/** A fresh project: its own team, a sale some of the backers bid in, settled through the web's own bid logic. */
async function relaunch(n) {
  const team = [agent(`founder-${n}`), agent(`cofounder-${n}`)];
  const p = await launch(KIT, team[0], `E${n}`, 20_000n, [
    { address: team[0], percent: randInt(50, 90) },
    { address: team[1], percent: 0 },
  ].map((seat, i, all) => (i === 1 ? { ...seat, percent: 100 - all[0].percent } : seat)));
  const bidders = BACKERS.filter(() => chance(0.6));
  const [book] = await runSales([{ p, bidders: bidders.length ? bidders : BACKERS, intensity: 0.9 }]);
  const r = await send(pick(BACKERS), p.executor, encodeExecuteGraduation(p.auction));
  hit(ok(r) ? "sale.graduated" : "sale.notGraduated");
  await settle(p, book);
  await checkSale(p, book, ok(r));
  if (!ok(r)) return relaunch(n + 1000);
  await adopt({ ...p, mandateFactory: MANDATE_FACTORY });
}

// ---- main ----------------------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  console.log(`[simulate-raise] anvil on ${RPC}, seed ${SEED}, ${AGENTS} backers, ${STEPS} steps`);
  await boot();
  const { kit, mandateFactory } = await deployStack();
  KIT = kit;
  MANDATE_FACTORY = mandateFactory;

  console.log("[simulate-raise] launching two projects and running both sales");
  const met = await launch(kit, FOUNDER, "A", 30_000n, [
    { address: FOUNDER, percent: 70 },
    { address: COFOUNDER, percent: 30 },
  ]);
  const missed = await launch(kit, FOUNDER_B, "B", 50_000_000n, [{ address: FOUNDER_B, percent: 100 }]);
  // Both sales run side by side; the second can never meet its target. The same backers bid on both.
  const [bookA, bookB] = await runSales([
    { p: met, bidders: BACKERS, intensity: 0.9 },
    { p: missed, bidders: BIDDERS_B, intensity: 0.5 },
  ]);
  for (const p of [met, missed]) {
    currentStep = `graduate ${p.plan.symbol}`;
    const r = await send(pick(BACKERS), p.executor, encodeExecuteGraduation(p.auction));
    hit(ok(r) ? "sale.graduated" : "sale.notGraduated");
    p.graduated = ok(r);
  }
  if (!met.graduated) throw new Error(`the met raise did not graduate: adjust the bidding ${JSON.stringify(counts)}`);
  if (missed.graduated) broke("a raise below its target graduated", missed.auction);
  await settle(met, bookA);
  await settle(missed, bookB);
  await checkSale(met, bookA, true);
  await checkSale(missed, bookB, false);

  await adopt({ ...met, mandateFactory });
  console.log(`[simulate-raise] ${STEPS} random steps, starting on ${P.dao}`);
  let epoch = 0;
  const actions = [
    [stepTransfer, 10],
    [stepExit, 4],
    [stepPropose, 6],
    [stepVote, 22],
    [stepExecute, 10],
    [stepMilestone, 22],
    [stepWork, 5],
    [stepReviewerBond, 4],
    [stepAttack, 4],
    [stepIssuer, 2],
    [stepTime, 9],
  ];
  const total = actions.reduce((a, [, w]) => a + w, 0);
  for (let step = 1; step <= STEPS; step++) {
    let roll = rand() * total;
    let action = actions[0][0];
    for (const [fn, w] of actions) {
      if ((roll -= w) < 0) {
        action = fn;
        break;
      }
    }
    currentStep = `step ${step} ${action.name}`;
    const expect = {
      daoUsdcBefore: await usdcBalance(P.dao),
      supplyBefore: word(await call(P.shares, S.totalSupply)),
      allowedOut: 0n,
      burnAllowed: false,
    };
    try {
      await action(expect);
    } catch (e) {
      // A client-side refusal (a form that would not compose this input) is not a chain event; count it and go on.
      hit(`client.${action.name}`);
      if (!(e instanceof Error) || !/DecisionInputError|must|cannot|Pick|Give|Name/.test(`${e.name} ${e.message}`)) {
        breaks.push({ step: currentStep, invariant: "simulation error", detail: String(e?.stack ?? e).slice(0, 400) });
        console.log(`  !! simulation error at ${currentStep}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    await checkInvariants(expect);
    // A project whose milestones are all settled (unlocked, burned or given up) has nothing left to find: launch the next.
    if (await scheduleOver()) {
      epoch++;
      currentStep = `step ${step} relaunch ${epoch}`;
      await relaunch(epoch);
      hit("project.relaunched");
    }
    if (step % 250 === 0) console.log(`  step ${step}: ${breaks.length} invariant breaks so far`);
  }

  const ms = await readMilestones();
  const report = {
    seed: SEED,
    steps: STEPS,
    agents: AGENTS,
    seconds: Math.round((Date.now() - started) / 1000),
    invariantChecks,
    breaks,
    finalMilestones: ms.map((m) => ({ phase: ["none", "pending", "voting", "stood"][m.phase], lateObjected: m.lateObjected })),
    proposals: { opened: proposals.length, executed: proposals.filter((p) => p.executed).length },
    counts: Object.fromEntries(Object.entries(counts).sort()),
  };
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  console.log(`[simulate-raise] ${STEPS} steps, ${invariantChecks} invariant checks, ${breaks.length} breaks, ${report.seconds}s`);
  console.log(`[simulate-raise] report: ${REPORT}`);
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k.padEnd(32)} ${v}`);
  stopAnvil();
  process.exit(breaks.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  stopAnvil();
  process.exit(2);
});
