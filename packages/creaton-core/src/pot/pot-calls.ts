/**
 * The chain calls of the money contracts (`contracts/pot`) as plain data for a sender to send: `{to, data, value}`, built
 * from the generated ABIs (`abis.generated.ts`) so no signature is typed by hand. Pure: the calldata of each builder is
 * read back with the ABI in `pot-calls.test.mjs`, and a few are pinned against `cast calldata`.
 *
 * A builder returns the call for the account that sends it. A project run by a Pair needs both signers for the
 * runner-only calls; the Pair's own wrapper (`team-calls.ts`, `asRunner`) takes `call.to` and `call.data` of these.
 */
import { type AbiValue, encodeParameters } from "../launchpad/evmAbi.ts";
import {
  EARLIER_GRANTS_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";
import { type Abi, encodeCall } from "./abi-codec.ts";

/** One call for a sender: always carries a zero native value. */
export interface PotCall {
  to: string;
  data: string;
  value: "0x0";
}

/** The zero address: "the payer" in a Back's `to`, and "nobody" elsewhere. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function build(
  abi: Abi,
  to: string,
  name: string,
  args: readonly AbiValue[],
): PotCall {
  return {
    to: to.toLowerCase(),
    data: encodeCall(abi, name, args),
    value: "0x0",
  };
}

// --- The dollar ---------------------------------------------------------------------------------------------------

/** Let `spender` take up to `amount` dollars of the sender's. */
function approveCall(dollar: string, spender: string, amount: bigint): PotCall {
  return build(PLAY_DOLLAR_ABI, dollar, "approve", [spender, amount]);
}

/** Take the test network's 1,000 play dollars, once per account. */
export function faucetCall(dollar: string): PotCall {
  return build(PLAY_DOLLAR_ABI, dollar, "faucet", []);
}

// --- Back and take out --------------------------------------------------------------------------------------------

/**
 * Back a project with `amount` dollars (fee included) and get at least `minShares`.
 * - `payAndCall` true (the play dollar): ONE call, `transferAndCall(treasury, amount, abi.encode(minShares, to))`. The
 *   Treasury joins inside it, with exactly 64 bytes of data, only for the sender's own money.
 * - `payAndCall` false (a dollar with no `transferAndCall`): `approve` then `join`, in that order; the sender lets the
 *   first land before it sends the second.
 * `to` is who receives the Shares. In the one-call form the zero address (the default) means the payer; in the two-call
 * form `Treasury.join` does NOT read zero that way (the Shares would go nowhere and the call is refused), so `to` must
 * be named there: the account that sends.
 */
export function backCalls(input: {
  dollar: string;
  treasury: string;
  amount: bigint;
  minShares: bigint;
  to?: string;
  payAndCall: boolean;
}): PotCall[] {
  const to = input.to ?? ZERO_ADDRESS;
  if (input.payAndCall) {
    // abi.encode(uint256 minShares, address to): two words, 64 bytes.
    const payload = encodeParameters(
      ["uint256", "address"],
      [input.minShares, to],
    );
    return [
      build(PLAY_DOLLAR_ABI, input.dollar, "transferAndCall", [
        input.treasury,
        input.amount,
        payload,
      ]),
    ];
  }
  if (to.toLowerCase() === ZERO_ADDRESS)
    throw new Error(
      "A Back by approve and join needs the account that gets the Shares",
    );
  return [
    approveCall(input.dollar, input.treasury, input.amount),
    build(TREASURY_ABI, input.treasury, "join", [
      input.amount,
      input.minShares,
      to,
    ]),
  ];
}

/** Take out: burn `shares` of the sender's own Shares for at least `minCash` dollars, paid to `to`. One call. */
export function leaveCall(input: {
  treasury: string;
  shares: bigint;
  minCash: bigint;
  to: string;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "leave", [
    input.shares,
    input.minCash,
    input.to,
  ]);
}

/** Take out Team Shares (they pay only what the pot holds above what backers put in): at least `minCash` or nothing. */
export function leaveTeamCall(input: {
  treasury: string;
  shares: bigint;
  minCash: bigint;
  to: string;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "leaveTeam", [
    input.shares,
    input.minCash,
    input.to,
  ]);
}

// --- Outside money and fees ---------------------------------------------------------------------------------------

/** Pay `amount` outside dollars into the project: approve, then add (anyone). */
export function addRevenueCalls(input: {
  dollar: string;
  treasury: string;
  amount: bigint;
}): PotCall[] {
  return [
    approveCall(input.dollar, input.treasury, input.amount),
    build(TREASURY_ABI, input.treasury, "addRevenue", [input.amount]),
  ];
}

/** Send the platform's fee waiting in the Treasury to the platform (anyone). */
export function collectFeesCall(treasury: string): PotCall {
  return build(TREASURY_ABI, treasury, "collectFees", []);
}

// --- The runner ---------------------------------------------------------------------------------------------------

/** The weekly check-in with the hash of the record signed first (the weekly update's event id). */
export function checkInCall(treasury: string, recordHash: string): PotCall {
  return build(TREASURY_ABI, treasury, "checkIn", [recordHash]);
}

/** A Pair signer's check-in (either signer alone), with the same hash. */
export function pairCheckInCall(pair: string, recordHash: string): PotCall {
  return build(PAIR_ABI, pair, "checkIn", [recordHash]);
}

/** Draw `amount` dollars from the allowance box to `to` (the runner; an agent inside its own daily limit). */
export function drawCall(input: {
  treasury: string;
  to: string;
  amount: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "draw", [input.to, input.amount]);
}

/** Lower the daily allowance at once; `ppm` is parts per million of the pot a day (1000 is 0.10%). */
export function setRateCall(treasury: string, ppm: number): PotCall {
  return build(TREASURY_ABI, treasury, "setRate", [BigInt(ppm)]);
}

/** Announce a higher allowance; anyone may apply it after one time unit. */
export function proposeRateCall(treasury: string, ppm: number): PotCall {
  return build(TREASURY_ABI, treasury, "proposeRate", [BigInt(ppm)]);
}

/** Apply the announced allowance once its unit has passed (anyone). */
export function applyRateCall(treasury: string): PotCall {
  return build(TREASURY_ABI, treasury, "applyRate", []);
}

/** Open or shut the door to new backers. */
export function setDoorCall(treasury: string, open: boolean): PotCall {
  return build(TREASURY_ABI, treasury, "setDoor", [open]);
}

/** Grant `amount` Team Shares (18 decimals, at least one whole Share) to `member`; they vest over active time. */
export function grantTeamCall(input: {
  treasury: string;
  member: string;
  amount: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "grantTeam", [
    input.member,
    input.amount,
  ]);
}

/** Let an account act as a helper with the platform's default daily limits. */
export function authoriseAgentCall(treasury: string, agent: string): PotCall {
  return build(TREASURY_ABI, treasury, "authoriseAgent", [agent]);
}

/** Set a helper's own daily limits: dollars out of the box and Team Shares (18 decimals). */
export function setAgentCall(input: {
  treasury: string;
  agent: string;
  usdCap: bigint;
  teamCap: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "setAgent", [
    input.agent,
    input.usdCap,
    input.teamCap,
  ]);
}

/** Switch a helper off. */
export function revokeAgentCall(treasury: string, agent: string): PotCall {
  return build(TREASURY_ABI, treasury, "revokeAgent", [agent]);
}

/** Offer the runner seat to `next` (the zero address withdraws an offer); `founderLeaves` trims the founder's own grants. */
export function handOverCall(input: {
  treasury: string;
  next: string;
  founderLeaves: boolean;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "handOver", [
    input.next,
    input.founderLeaves,
  ]);
}

/** Take the runner seat that was offered to the sender. */
export function takeSeatCall(treasury: string): PotCall {
  return build(TREASURY_ABI, treasury, "takeSeat", []);
}

// --- Tasks (the Treasury's task queue; `contracts/pot/src/TaskBook.sol`) -----------------------------------------------

const UINT64_MAX = (1n << 64n) - 1n;
/** The book keeps every amount as a uint128. */
const UINT128_MAX = (1n << 128n) - 1n;
/** The most one task may ask for, in ten-thousandths of the pot (the book's `MAX_SHARE_BPS`; the contract has the last word). */
const MAX_TASK_SHARE_BPS = 500;

/** A task's number: a whole number from 1 (serials start at 1 and never repeat) that fits a uint64. */
function taskSerial(serial: bigint): bigint {
  if (typeof serial !== "bigint" || serial < 1n || serial > UINT64_MAX)
    throw new Error("A task number is a whole number from 1");
  return serial;
}

/** A dollar amount in raw units: more than nothing and no more than the book can keep. */
function taskAmount(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 1n || value > UINT128_MAX)
    throw new Error(`${label} must be more than nothing and a whole number`);
  return value;
}

/**
 * Plan a task (`Treasury.announceTask`). Sender: the runner (with a Pair, both signers, through a proposal). Nothing moves.
 * `what` is the 32-byte id of the team's signed task record; `payee` is who may take it (null: whoever takes it first);
 * `maxDollars` the most it may set aside, in raw dollar units; `shareBps` the share of the pot it may ask for, 1 to 500
 * ten-thousandths. The contract still decides every other limit (the smallest task, the open count, who the payee may be).
 */
export function announceTaskCall(input: {
  treasury: string;
  what: string;
  payee: string | null;
  maxDollars: bigint;
  shareBps: number;
}): PotCall {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.what) || /^0x0{64}$/.test(input.what))
    throw new Error("A task is named by the 32-byte id of its record");
  if (
    !Number.isInteger(input.shareBps) ||
    input.shareBps < 1 ||
    input.shareBps > MAX_TASK_SHARE_BPS
  )
    throw new Error(
      "A task's share is from 0.01% to 5% of the project's money",
    );
  return build(TREASURY_ABI, input.treasury, "announceTask", [
    input.what.toLowerCase(),
    input.payee === null ? ZERO_ADDRESS : input.payee,
    taskAmount(input.maxDollars, "What a task may cost"),
    BigInt(input.shareBps),
  ]);
}

/**
 * Take a planned task (`Treasury.takeTask`) and have its money set aside. Sender: the named payee, never the runner or a
 * signer. `minAmount` is the least the taker accepts to have set aside: the call is refused if less would be.
 */
export function takeTaskCall(input: {
  treasury: string;
  serial: bigint;
  minAmount: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "takeTask", [
    taskSerial(input.serial),
    taskAmount(input.minAmount, "The least to set aside"),
  ]);
}

/**
 * Pay `payDollars` of a taken task's set-aside money (`Treasury.acceptTask`). Sender: the runner (with a Pair, both).
 * There is no recipient: the money goes to whoever took the task, and to nobody else.
 */
export function acceptTaskCall(input: {
  treasury: string;
  serial: bigint;
  payDollars: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "acceptTask", [
    taskSerial(input.serial),
    taskAmount(input.payDollars, "A payment"),
  ]);
}

/** Send a taken task's money back, paying nobody (`Treasury.rejectTask`). Sender: the runner (with a Pair, both). */
export function rejectTaskCall(input: {
  treasury: string;
  serial: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "rejectTask", [
    taskSerial(input.serial),
  ]);
}

/** Withdraw a planned task nobody has taken (`Treasury.cancelTask`). Sender: the runner (with a Pair, both). */
export function cancelTaskCall(input: {
  treasury: string;
  serial: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "cancelTask", [
    taskSerial(input.serial),
  ]);
}

/** Make sure a task that ran out is back in the project (`Treasury.returnTask`). Sender: anyone. */
export function returnTaskCall(input: {
  treasury: string;
  serial: bigint;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "returnTask", [
    taskSerial(input.serial),
  ]);
}

/**
 * Claim `holder`'s note on an ended task (`Treasury.claimNote`). Anyone may send it; the money goes to `holder` only. The
 * app always passes the connected account, so a person can only ever claim for themselves.
 */
export function claimNoteCall(input: {
  treasury: string;
  serial: bigint;
  holder: string;
}): PotCall {
  return build(TREASURY_ABI, input.treasury, "claimNote", [
    taskSerial(input.serial),
    input.holder,
  ]);
}

// --- A member's grant ---------------------------------------------------------------------------------------------

/** Send a grant's unlocked Team Shares to its member (anyone may press; the Shares go to the member). */
export function claimGrantCall(vester: string, id: bigint): PotCall {
  return build(VESTER_ABI, vester, "claim", [id]);
}

/** A member's own exit from a grant: announce that the part not yet unlocked burns after the notice. */
export function announceForfeitCall(vester: string, id: bigint): PotCall {
  return build(VESTER_ABI, vester, "announceForfeit", [id]);
}

/**
 * Announce the forfeit of a member's grant without the member's say: a call on the Treasury that only both signers of a
 * Pair can make, so it is what waits in a Pair (the member's own `announceForfeitCall` is on the Vester).
 */
export function runnerForfeitCall(treasury: string, id: bigint): PotCall {
  return build(TREASURY_ABI, treasury, "announceForfeit", [id]);
}

/** Run an announced burn once its notice is over (anyone). */
export function executeForfeitCall(vester: string, id: bigint): PotCall {
  return build(VESTER_ABI, vester, "execute", [id]);
}

// --- The Launcher -------------------------------------------------------------------------------------------------

/** Put a project on the network. `terms` are the allowance rate (ppm) and the Team pool (18 decimals). */
export function launchCall(input: {
  launcher: string;
  projectId: string;
  name: string;
  symbol: string;
  ratePpm: number;
  teamPool: bigint;
  settingsHash: string;
}): PotCall {
  return build(LAUNCHER_ABI, input.launcher, "launch", [
    input.projectId,
    input.name,
    input.symbol,
    [BigInt(input.ratePpm), input.teamPool],
    input.settingsHash,
  ]);
}

/** Accept the second seat: the sender and `first` become the project's Pair. */
export function makePairCall(
  launcher: string,
  key: string,
  first: string,
): PotCall {
  return build(LAUNCHER_ABI, launcher, "makePair", [key, first]);
}

/** Wind the project down by choice (the runner; with a Pair, both signers through a proposal). */
export function windDownCall(launcher: string, key: string): PotCall {
  return build(LAUNCHER_ABI, launcher, "windDown", [key]);
}

// --- A Pair (two signers) -----------------------------------------------------------------------------------------

/** Propose a call to the Treasury or the Launcher through the Pair: it runs when the other signer confirms the same call. */
export function pairProposeCall(
  pair: string,
  target: string,
  data: string,
): PotCall {
  return build(PAIR_ABI, pair, "propose", [target, data]);
}

/** Confirm the other signer's proposal (the exact target, data and nonce it was proposed with) and run it. */
export function pairConfirmCall(
  pair: string,
  target: string,
  data: string,
  nonce: bigint,
): PotCall {
  return build(PAIR_ABI, pair, "confirm", [target, data, nonce]);
}

/** Withdraw a call you proposed. */
export function pairCancelCall(pair: string, id: string): PotCall {
  return build(PAIR_ABI, pair, "cancel", [id]);
}

/** Wind the project down on the Treasury itself: the runner by choice, or anyone after a long quiet (`Treasury.windDown`). */
export function treasuryWindDownCall(treasury: string): PotCall {
  return build(TREASURY_ABI, treasury, "windDown", []);
}

// --- The earlier backers' claim (step 4; only where the build is given its settings) -----------------------------------

/**
 * Claim a row of the earlier backers' list: the row's index and amount, its Merkle proof (32-byte hashes) and the fingerprint of
 * the text the claimant accepts, which the contract compares with its own. The row's account is the sender.
 */
export function earlierClaimCall(input: {
  contract: string;
  index: bigint;
  amount: bigint;
  proof: readonly string[];
  accepted: string;
}): PotCall {
  return build(EARLIER_GRANTS_ABI, input.contract, "claim", [
    input.index,
    input.amount,
    input.proof,
    input.accepted,
  ]);
}
