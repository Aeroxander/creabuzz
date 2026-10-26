/**
 * The $CREATE court (N7, `contracts/src/CreateCourt.sol`, docs/v3-review/COURT.md): what a juror has staked, the cases
 * and where each stands, what the connected wallet can do with each, and the calls that do it.
 *
 * A vote is sealed, then opened. The secret that seals it is derived from a signature the juror's wallet makes over a
 * fixed message for that case and round (`voteKeyMessage`), so opening it later only needs the same wallet to sign again;
 * nothing has to survive in the browser.
 *
 * Pure apart from the reader, whose chain is injected (`court.test.mjs` runs it against a fake one). Selectors and the
 * seal are pinned to `cast` in the same test.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import {
  decodeParameters,
  encodeFunctionData,
  encodeParameters,
} from "./evmAbi.ts";
import { decodeWord, encodeCall0, topicOf } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;

export const EVIDENCE = 2 * DAY;
export const COMMIT = 2 * DAY;
export const REVEAL = 2 * DAY;
export const APPEAL = 2 * DAY;
export const DRAW_TIMEOUT = 14 * DAY;
export const MAX_ROUNDS = 3;
/** The most cases read at once, newest first. */
export const MAX_CASES = 50;

export const COURT_SIGNATURES = {
  stake: "stake(uint256)",
  unstake: "unstake(uint256)",
  withdraw: "withdraw()",
  draw: "draw(uint256)",
  commit: "commit(uint256,bytes32)",
  reveal: "reveal(uint256,uint8,bytes32)",
  passPeriod: "passPeriod(uint256)",
  appeal: "appeal(uint256)",
  execute: "execute(uint256)",
  timeout: "timeout(uint256)",
  submitEvidence: "submitEvidence(uint256,string)",
  jurors: "jurors(address)",
  disputes: "disputes(uint256)",
  roundOf: "roundOf(uint256,uint256)",
  votes: "votes(uint256,uint256,address)",
  owedFee: "owedFee(address)",
  owedStake: "owedStake(address)",
  freeSeats: "freeSeats()",
  disputeCount: "disputeCount()",
  appealCost: "appealCost(uint256)",
  seatStake: "seatStake()",
  feePerSeat: "feePerSeat()",
  stakeToken: "stakeToken()",
  feeToken: "feeToken()",
} as const;

/** The test $CREATE faucet (N6): once a day per wallet. */
export const FAUCET_SIGNATURES = {
  drip: "drip()",
  lastDrip: "lastDrip(address)",
} as const;

export const encodeDrip = (): string => encodeCall0(FAUCET_SIGNATURES.drip);

export function encodeLastDrip(wallet: string): string {
  if (!ADDRESS_RE.test(wallet)) throw new Error("not an address");
  return encodeFunctionData(FAUCET_SIGNATURES.lastDrip, ["address"], [wallet]);
}

export const TOPIC_DISPUTE_CREATED = topicOf(
  "DisputeCreated(uint256,address,uint256,bytes)",
);

export type Period = "evidence" | "commit" | "reveal" | "appeal" | "ruled";
const PERIODS: readonly Period[] = [
  "evidence",
  "commit",
  "reveal",
  "appeal",
  "ruled",
];

const id1 = (signature: string, id: bigint) =>
  encodeFunctionData(signature, ["uint256"], [id]);

function assertAmount(amount: bigint): void {
  if (amount <= 0n || amount >= 1n << 96n) {
    throw new Error("the amount must be above zero");
  }
}

// ---- calls ---------------------------------------------------------------------------------------

export function encodeStake(amount: bigint): string {
  assertAmount(amount);
  return encodeFunctionData(COURT_SIGNATURES.stake, ["uint256"], [amount]);
}

export function encodeUnstake(amount: bigint): string {
  assertAmount(amount);
  return encodeFunctionData(COURT_SIGNATURES.unstake, ["uint256"], [amount]);
}

export const encodeWithdrawCourt = (): string =>
  encodeCall0(COURT_SIGNATURES.withdraw);
export const encodeDraw = (id: bigint): string =>
  id1(COURT_SIGNATURES.draw, id);
export const encodePassPeriod = (id: bigint): string =>
  id1(COURT_SIGNATURES.passPeriod, id);
export const encodeAppealCase = (id: bigint): string =>
  id1(COURT_SIGNATURES.appeal, id);
export const encodeExecute = (id: bigint): string =>
  id1(COURT_SIGNATURES.execute, id);
export const encodeTimeout = (id: bigint): string =>
  id1(COURT_SIGNATURES.timeout, id);

export function encodeCommit(id: bigint, hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("not a seal");
  return encodeFunctionData(
    COURT_SIGNATURES.commit,
    ["uint256", "bytes32"],
    [id, hash],
  );
}

export function encodeReveal(id: bigint, choice: 1 | 2, salt: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("not a secret");
  return encodeFunctionData(
    COURT_SIGNATURES.reveal,
    ["uint256", "uint8", "bytes32"],
    [id, BigInt(choice), salt],
  );
}

export function encodeEvidence(id: bigint, text: string): string {
  const n = new TextEncoder().encode(text.trim()).length;
  if (n === 0 || n > 1000) throw new Error("evidence must be 1 to 1000 bytes");
  return encodeFunctionData(
    COURT_SIGNATURES.submitEvidence,
    ["uint256", "string"],
    [id, text.trim()],
  );
}

// ---- sealing a vote ------------------------------------------------------------------------------

/** What the juror's wallet signs to make the secret for one case and round: the same words give the same secret. */
export function voteKeyMessage(
  court: string,
  id: bigint,
  round: number,
): string {
  return `Creaton court: my vote key for case ${id} round ${round + 1} at ${court.toLowerCase()}. Signing this costs nothing.`;
}

/** The secret, from the wallet's signature over `voteKeyMessage`. */
export function saltFromSignature(signature: string): string {
  return `0x${bytesToHex(keccak_256(hexToBytes(signature.replace(/^0x/, ""))))}`;
}

/** Which way a sealed vote went, by trying both choices against the seal: null when neither matches this secret. */
export function sealedChoice(
  commit: string,
  salt: string,
  juror: string,
  id: bigint,
  round: number,
): 1 | 2 | null {
  const seal = commit.toLowerCase();
  if (commitHash(1, salt, juror, id, round) === seal) return 1;
  if (commitHash(2, salt, juror, id, round) === seal) return 2;
  return null;
}

/** The seal the court checks: keccak256(abi.encode(choice, salt, juror, id, round)). */
export function commitHash(
  choice: 1 | 2,
  salt: string,
  juror: string,
  id: bigint,
  round: number,
): string {
  if (!ADDRESS_RE.test(juror)) throw new Error("not an address");
  const encoded = encodeParameters(
    ["uint8", "bytes32", "address", "uint256", "uint256"],
    [BigInt(choice), salt, juror.toLowerCase(), id, BigInt(round)],
  );
  return `0x${bytesToHex(keccak_256(hexToBytes(encoded.slice(2))))}`;
}

// ---- reads ---------------------------------------------------------------------------------------

export interface CourtJuror {
  staked: bigint;
  locked: bigint;
  freeSeats: number;
  owedFee: bigint;
  owedStake: bigint;
}

export interface CaseRound {
  seats: number;
  fee: bigint;
  committed: number;
  revealed: number;
  forSeats: number;
  againstSeats: number;
  drawn: string[];
}

export interface CourtCase {
  id: bigint;
  arbitrable: string;
  /** What the case is about, when the asking contract is a bounty on a post: its id and the appealed claim. */
  about: { bounty: bigint; claim: number } | null;
  period: Period;
  periodStart: number;
  /** How many rounds so far (1 to 3). */
  rounds: number;
  /** The round's ruling once opened, the final ruling once ruled: 1 for, 2 against, 0 none. */
  ruling: number;
  round: CaseRound;
  /** The connected wallet's part in the current round; `commit` is its seal, to tell which way it voted when opening. */
  mine: {
    seats: number;
    sealed: boolean;
    commit: string;
    choice: number;
  } | null;
  appealCost: bigint;
}

export interface CourtView {
  court: string;
  stakeToken: string;
  feeToken: string;
  seatStake: bigint;
  feePerSeat: bigint;
  freeSeats: number;
  juror: CourtJuror | null;
  cases: CourtCase[];
  truncated: boolean;
}

const wordsOf = (hex: string): bigint[] => {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return out;
};
const addressOf = (word: bigint): string =>
  `0x${word.toString(16).padStart(40, "0")}`;

/** `disputes(uint256)`: asker, rounds, period, period start, ruling. Null for a case that does not exist. */
export function decodeDispute(hex: string): {
  arbitrable: string;
  rounds: number;
  period: Period;
  periodStart: number;
  ruling: number;
} | null {
  const w = wordsOf(hex);
  if (w.length < 5 || w[0] === 0n) return null;
  return {
    arbitrable: addressOf(w[0]),
    rounds: Number(w[1]),
    period: PERIODS[Number(w[2])] ?? "ruled",
    periodStart: Number(w[3]),
    ruling: Number(w[4]),
  };
}

export function decodeRound(hex: string): CaseRound {
  const [seats, fee, committed, revealed, forSeats, againstSeats, drawn] =
    decodeParameters(
      [
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        { array: "address" },
      ],
      hex,
    ) as [bigint, bigint, bigint, bigint, bigint, bigint, string[]];
  return {
    seats: Number(seats),
    fee,
    committed: Number(committed),
    revealed: Number(revealed),
    forSeats: Number(forSeats),
    againstSeats: Number(againstSeats),
    drawn: drawn.map((a) => a.toLowerCase()),
  };
}

/** When the case's current period ends (Unix seconds), or null when it waits on someone and has no end. */
export function periodEnds(
  c: Pick<CourtCase, "period" | "periodStart" | "rounds">,
): number | null {
  switch (c.period) {
    case "evidence":
      return c.rounds === 1 ? c.periodStart + EVIDENCE : c.periodStart;
    case "commit":
      return c.periodStart + COMMIT;
    case "reveal":
      return c.periodStart + REVEAL;
    case "appeal":
      return c.rounds === MAX_ROUNDS ? c.periodStart : c.periodStart + APPEAL;
    case "ruled":
      return null;
  }
}

/** What anyone, and the connected wallet, can do with a case at chain time `now`: each the court's own condition. */
export function caseActions(
  c: CourtCase,
  freeSeats: number,
  now: number,
): {
  draw: boolean;
  timeout: boolean;
  seal: boolean;
  open: boolean;
  moveOn: boolean;
  appeal: boolean;
  settle: boolean;
} {
  const ends = periodEnds(c);
  const drawableFrom =
    c.rounds === 1 ? c.periodStart + EVIDENCE : c.periodStart;
  const mine = c.mine;
  const everyoneSealed = c.round.committed >= c.round.drawn.length;
  const everyoneOpened = c.round.revealed >= c.round.committed;
  return {
    draw:
      c.period === "evidence" &&
      now >= drawableFrom &&
      freeSeats >= c.round.seats,
    timeout: c.period === "evidence" && now >= drawableFrom + DRAW_TIMEOUT,
    seal:
      c.period === "commit" &&
      ends !== null &&
      now < ends &&
      mine !== null &&
      mine.seats > 0 &&
      !mine.sealed,
    open:
      c.period === "reveal" &&
      ends !== null &&
      now < ends &&
      mine !== null &&
      mine.sealed &&
      mine.choice === 0,
    moveOn:
      (c.period === "commit" &&
        ends !== null &&
        (now >= ends || everyoneSealed)) ||
      (c.period === "reveal" &&
        ends !== null &&
        (now >= ends || everyoneOpened)),
    appeal:
      c.period === "appeal" &&
      c.rounds < MAX_ROUNDS &&
      ends !== null &&
      now < ends,
    settle: c.period === "appeal" && ends !== null && now >= ends,
  };
}

/** The extra data a bounty on a post sends the court: abi.encode(bounty id, claim). */
export function decodeAbout(extraData: string): CourtCase["about"] {
  try {
    const [bounty, claim] = decodeParameters(["uint256", "uint32"], extraData);
    return { bounty: bounty as bigint, claim: Number(claim as bigint) };
  } catch {
    return null;
  }
}

interface LogLike {
  topics?: unknown;
  data?: unknown;
}

/** The court, the connected wallet's stake, and the newest cases (bounded by `MAX_CASES`). */
export async function readCourt(
  chain: Pick<WorkChain, "call" | "logs">,
  court: string,
  wallet: string | null,
): Promise<CourtView> {
  if (!ADDRESS_RE.test(court)) throw new Error("not a court");
  const read = (signature: string) =>
    chain.call(court, encodeCall0(signature)).then(decodeWord);
  const [stakeToken, feeToken, seatStake, feePerSeat, freeSeats, logs] =
    await Promise.all([
      read(COURT_SIGNATURES.stakeToken),
      read(COURT_SIGNATURES.feeToken),
      read(COURT_SIGNATURES.seatStake),
      read(COURT_SIGNATURES.feePerSeat),
      read(COURT_SIGNATURES.freeSeats),
      chain.logs({ address: court, topics: [TOPIC_DISPUTE_CREATED] }),
    ]);
  const created = logs
    .flatMap((raw) => {
      const log = raw as LogLike;
      const t = Array.isArray(log.topics) ? (log.topics as string[]) : [];
      if (t.length !== 3 || typeof log.data !== "string") return [];
      try {
        const [, extra] = decodeParameters(["uint256", "bytes"], log.data);
        return [{ id: BigInt(t[1]), about: decodeAbout(String(extra)) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  const shown = created.slice(0, MAX_CASES);
  const cases = (
    await Promise.all(
      shown.map(async ({ id, about }): Promise<CourtCase | null> => {
        const d = decodeDispute(
          await chain.call(court, id1(COURT_SIGNATURES.disputes, id)),
        );
        if (!d) return null;
        const r = BigInt(d.rounds - 1);
        const [roundHex, voteHex, appealCost] = await Promise.all([
          chain.call(
            court,
            encodeFunctionData(
              COURT_SIGNATURES.roundOf,
              ["uint256", "uint256"],
              [id, r],
            ),
          ),
          wallet
            ? chain.call(
                court,
                encodeFunctionData(
                  COURT_SIGNATURES.votes,
                  ["uint256", "uint256", "address"],
                  [id, r, wallet],
                ),
              )
            : Promise.resolve(null),
          d.rounds < MAX_ROUNDS && d.period !== "ruled"
            ? chain
                .call(court, id1(COURT_SIGNATURES.appealCost, id))
                .then(decodeWord)
            : Promise.resolve(0n),
        ]);
        const vote = voteHex ? wordsOf(voteHex) : null;
        return {
          id,
          about,
          ...d,
          round: decodeRound(roundHex),
          mine:
            vote && vote.length >= 3
              ? {
                  seats: Number(vote[0]),
                  sealed: vote[1] !== 0n,
                  commit: `0x${vote[1].toString(16).padStart(64, "0")}`,
                  choice: Number(vote[2]),
                }
              : null,
          appealCost,
        };
      }),
    )
  ).flatMap((c) => (c ? [c] : []));
  let juror: CourtJuror | null = null;
  if (wallet) {
    const call = (signature: string) =>
      chain
        .call(court, encodeFunctionData(signature, ["address"], [wallet]))
        .then((hex) => hex);
    const [j, owedFee, owedStake] = await Promise.all([
      call(COURT_SIGNATURES.jurors),
      call(COURT_SIGNATURES.owedFee).then(decodeWord),
      call(COURT_SIGNATURES.owedStake).then(decodeWord),
    ]);
    const w = wordsOf(j);
    const staked = w[0] ?? 0n;
    const locked = w[1] ?? 0n;
    juror = {
      staked,
      locked,
      freeSeats: seatStake === 0n ? 0 : Number((staked - locked) / seatStake),
      owedFee,
      owedStake,
    };
  }
  return {
    court: court.toLowerCase(),
    stakeToken: addressOf(stakeToken),
    feeToken: addressOf(feeToken),
    seatStake,
    feePerSeat,
    freeSeats: Number(freeSeats),
    juror,
    cases,
    truncated: created.length > MAX_CASES,
  };
}
