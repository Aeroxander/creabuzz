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
  COUNCIL_ABI,
  EARLIER_GRANTS_ABI,
  HOLDER_PAUSE_ABI,
  HOLDER_VOTE_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";
import { type Abi, encodeCall, functionOf, signatureOf } from "./abi-codec.ts";
import { selectorOf } from "../launchpad/evmAbi.ts";

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

// --- The holder pause (step 4; only on a deployment that has switched it on) ---------------------------------------------

/**
 * Park `amount` backer Shares: the sender lets the project's pause contract take them (`approve` on the Shares), then parks
 * them. Two calls, in that order; a sender that cannot batch lets the first land before it sends the second. The Shares stay
 * the sender's: `unparkCall` takes them back at any time.
 */
export function parkCalls(input: {
  shares: string;
  pause: string;
  amount: bigint;
}): PotCall[] {
  return [
    build(SHARE_TOKEN_ABI, input.shares, "approve", [
      input.pause,
      input.amount,
    ]),
    build(HOLDER_PAUSE_ABI, input.pause, "park", [input.amount]),
  ];
}

/** Take `amount` of the sender's parked Shares back to the sender's wallet. One call, no condition, no fee. */
export function unparkCall(pause: string, amount: bigint): PotCall {
  return build(HOLDER_PAUSE_ABI, pause, "unpark", [amount]);
}

/**
 * Start the warning day: anyone may ask the pause contract to look at the share parked now and arm or disarm. It changes
 * nothing else and cannot fail for a reason that matters; it is the way back in when a join cleared the day and the share
 * parked is at the line again without anyone parking or taking back.
 */
export function pokeCall(pause: string): PotCall {
  return build(HOLDER_PAUSE_ABI, pause, "poke", []);
}

/**
 * Take out Shares that are partly parked: `unpark(parked)` first, then `leave(wallet + parked, minCash, to)`. The order is
 * the point: the Shares must be back in the wallet before `leave` burns them. A person with nothing parked gets the plain
 * `leave` and nothing else.
 */
export function takeOutWithParkedCalls(input: {
  treasury: string;
  pause: string | null;
  walletShares: bigint;
  parkedShares: bigint;
  minCash: bigint;
  to: string;
}): PotCall[] {
  const leave = leaveCall({
    treasury: input.treasury,
    shares: input.walletShares + input.parkedShares,
    minCash: input.minCash,
    to: input.to,
  });
  if (input.parkedShares === 0n) return [leave];
  if (!input.pause)
    throw new Error("Parked Shares need the project's pause contract");
  return [unparkCall(input.pause, input.parkedShares), leave];
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

// --- The vote and the Council (milestone 9; only on a deployment that switches them on) --------------------------------

/**
 * Five accounts as the contracts take them: exactly five, each an address. The contracts have the last word (distinct,
 * non-zero, none of the project's own); a wrong count is refused here instead of reaching a wallet.
 */
function fiveAccounts(members: readonly string[]): string[] {
  if (members.length !== 5) throw new Error("A list names five accounts");
  for (const member of members)
    if (!/^0x[0-9a-fA-F]{40}$/.test(member))
      throw new Error("A list names five accounts");
  return members.map((member) => member.toLowerCase());
}

/** One argument of a call written by hand: a fixed-size `address[5]`, or one 32-byte word (an address, a hash, a number). */
type StaticArg =
  | { readonly seats: readonly string[] }
  | { readonly word: string | bigint };

/**
 * A call whose arguments are fixed-size values the shared encoder has no type for: it supports no fixed-size arrays
 * (`Lib5` is `address[5]` in the vote and Launcher calls), so the words are written here. The selector and the
 * signature still come from the ABI, so the call cannot drift from the contract, and `pot-calls.test.mjs` reads the words
 * back one by one.
 */
function staticData(
  abi: Abi,
  name: string,
  args: readonly StaticArg[],
): string {
  const fn = functionOf(abi, name, args.length);
  const words = args.map((arg) => {
    if ("seats" in arg)
      return fiveAccounts(arg.seats)
        .map((member) => encodeParameters(["address"], [member]).slice(2))
        .join("");
    return typeof arg.word === "bigint"
      ? encodeParameters(["uint256"], [arg.word]).slice(2)
      : encodeParameters(
          [/^0x[0-9a-fA-F]{40}$/.test(arg.word) ? "address" : "bytes32"],
          [arg.word],
        ).slice(2);
  });
  return selectorOf(signatureOf(fn)) + words.join("");
}

function staticCall(
  abi: Abi,
  to: string,
  name: string,
  args: readonly StaticArg[],
): PotCall {
  return {
    to: to.toLowerCase(),
    data: staticData(abi, name, args),
    value: "0x0",
  };
}

/** A ballot's number: a whole number that fits a uint32. */
function ballotNumber(id: bigint): bigint {
  if (typeof id !== "bigint" || id < 1n || id > 0xffff_ffffn)
    throw new Error("A ballot's number is a whole number from 1");
  return id;
}

/**
 * Open a replace vote with the sender's own list, in one call (`HolderVote.openReplace`). Sender: a parked holder. The
 * contract decides whether enough Shares are parked and whether a ballot or a cooldown stands in the way.
 */
export function openReplaceCall(input: {
  vote: string;
  members: readonly string[];
  recordHash: string;
}): PotCall {
  return staticCall(HOLDER_VOTE_ABI, input.vote, "openReplace", [
    { seats: input.members },
    { word: input.recordHash },
  ]);
}

/** Open the seat election that is due (`HolderVote.openSeats`). Anyone may; the helper does. */
export function openSeatsCall(vote: string): PotCall {
  return build(HOLDER_VOTE_ABI, vote, "openSeats", []);
}

/** Stand the sender for a seat that came up, with the hash of its signed text (`HolderVote.stand`). */
export function standCall(vote: string, recordHash: string): PotCall {
  return build(HOLDER_VOTE_ABI, vote, "stand", [recordHash]);
}

/** Stand a list of five accounts for a replace vote, with the hash of its signed text (`HolderVote.standList`). */
export function standListCall(input: {
  vote: string;
  members: readonly string[];
  recordHash: string;
}): PotCall {
  return staticCall(HOLDER_VOTE_ABI, input.vote, "standList", [
    { seats: input.members },
    { word: input.recordHash },
  ]);
}

/** Put the sender's whole eligible weight on one option, or move it (`HolderVote.castVote`); option 0 is "keep". */
export function castVoteCall(vote: string, option: number): PotCall {
  if (!Number.isInteger(option) || option < 0 || option > 255)
    throw new Error("A choice is one of the ballot's options");
  return build(HOLDER_VOTE_ABI, vote, "castVote", [BigInt(option)]);
}

/** Record a ballot's result on the network once its vote has ended (`HolderVote.finish`). Anyone, once. */
export function finishCall(vote: string, id: bigint): PotCall {
  return build(HOLDER_VOTE_ABI, vote, "finish", [ballotNumber(id)]);
}

/** Put a won result in once its wait is over (`HolderVote.carryOut`). Anyone. */
export function carryOutCall(vote: string, id: bigint): PotCall {
  return build(HOLDER_VOTE_ABI, vote, "carryOut", [ballotNumber(id)]);
}

/** Let a won result nobody carried out lapse (`HolderVote.lapse`). Anyone, two time units after it was due. */
export function lapseCall(vote: string, id: bigint): PotCall {
  return build(HOLDER_VOTE_ABI, vote, "lapse", [ballotNumber(id)]);
}

/** Ask the Council's other seats to agree to a call (`Council.propose`); it runs when enough have. Sender: a seat. */
export function councilProposeCall(
  council: string,
  target: string,
  data: string,
): PotCall {
  return build(COUNCIL_ABI, council, "propose", [target, data]);
}

/** Agree to the same call another seat proposed (`Council.agree`), and run it once enough have. Sender: a seat. */
export function councilAgreeCall(
  council: string,
  target: string,
  data: string,
  nonce: bigint,
): PotCall {
  return build(COUNCIL_ABI, council, "agree", [target, data, nonce]);
}

/** Take the sender's agreement back (`Council.withdraw`). Sender: a seat that agreed. */
export function councilWithdrawCall(council: string, id: string): PotCall {
  return build(COUNCIL_ABI, council, "withdraw", [id]);
}

/** Give up the sender's own seat (`Council.resign`). Sender: a seat holder. */
export function resignCall(council: string): PotCall {
  return build(COUNCIL_ABI, council, "resign", []);
}

/**
 * Make the Council of five accounts the runner offered the seat to (`Launcher.makeCouncil`). Anyone may send it; the
 * address commits to the key, the five accounts and the salt (`councilAddressOf`), so nobody can change who they are.
 */
export function makeCouncilCall(input: {
  launcher: string;
  key: string;
  members: readonly string[];
  salt: string;
}): PotCall {
  // The Launcher's own argument order: the key, then the five accounts, then the salt.
  return staticCall(LAUNCHER_ABI, input.launcher, "makeCouncil", [
    { word: input.key },
    { seats: input.members },
    { word: input.salt },
  ]);
}

/** The data of `Launcher.councilAddress(key, members, salt)`: the address a hand-over to those five would make. */
export function councilAddressData(input: {
  key: string;
  members: readonly string[];
  salt: string;
}): string {
  return staticData(LAUNCHER_ABI, "councilAddress", [
    { word: input.key },
    { seats: input.members },
    { word: input.salt },
  ]);
}
