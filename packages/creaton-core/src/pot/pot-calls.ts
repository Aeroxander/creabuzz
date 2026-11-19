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
