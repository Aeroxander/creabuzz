/**
 * What the pause screens' tests share: a record with a pause in it (made by changing the example record's content, so it goes
 * through the app's real parser and its checks), and what the chain answers about the pause, by function name, for
 * `installPotChain`. Invented numbers only.
 */
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { numbersFor, S } from "./pot-harness";

/** The pause contract's address in these tests. */
export const PAUSE = `0x${"61".repeat(20)}`;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface PauseSetup {
  /** Shares parked in all. */
  parked: bigint;
  /** Seconds before the record's own time that the line was first seen reached; omit for "not armed". */
  armedAgo?: number;
  /** The line is one this-many-th (3 by default). */
  divisor?: number;
  /** How many accounts have parked (1 when anything is parked, by default). */
  parkers?: number;
}

/** The example record with a pause in it. `content` is the record's JSON body after the example's own changes. */
export function withPause(
  content: Record<string, unknown>,
  setup: PauseSetup,
): void {
  // biome-ignore lint/suspicious/noExplicitAny: the record's content is walked as loose JSON, the way the server writes it
  const c = content as Record<string, any>;
  const backers = BigInt(c.shares.backers);
  const divisor = BigInt(setup.divisor ?? 3);
  const day = Math.floor(c.unit / 7);
  const armedAt =
    setup.armedAgo === undefined ? null : c.asOf.time - setup.armedAgo;
  const pausesFrom = armedAt === null ? null : armedAt + day;
  const reached = setup.parked * divisor >= backers && backers > 0n;
  const paused = pausesFrom !== null && c.asOf.time >= pausesFrom && reached;
  c.contracts.pause = PAUSE;
  c.pause = {
    contract: PAUSE,
    parkedTotal: setup.parked.toString(),
    line: ceilDiv(backers, divisor).toString(),
    dayLength: day,
    lineDivisor: setup.divisor ?? 3,
    armedAt,
    pausesFrom,
    paused,
    since: paused ? pausesFrom : null,
    parkerCount: setup.parked === 0n ? 0 : (setup.parkers ?? 1),
  };
}

/** The numbers of the example project with a pause in them. */
export function numbersWithPause(setup: PauseSetup): ProjectNumbers {
  return numbersFor((content) => withPause(content, setup));
}

/**
 * What the chain answers about the pause: the Treasury names it, an account has `mine` parked in it, and its own state is
 * the numbers given. `backers` is the backers' Shares in all (parked ones included).
 */
export function pauseAnswers(input: {
  mine: bigint;
  parked: bigint;
  backers: bigint;
  armedAt?: number;
  paused?: boolean;
  dayLength?: number;
  divisor?: number;
}) {
  const divisor = BigInt(input.divisor ?? 3);
  const line = ceilDiv(input.backers, divisor);
  const day = BigInt(input.dayLength ?? 86_400);
  const armed = BigInt(input.armedAt ?? 0);
  return {
    pauseGate: [PAUSE],
    parkedOf: [input.mine],
    state: [
      input.parked,
      input.backers,
      line,
      armed,
      armed === 0n ? 0n : armed + day,
      input.paused ?? false,
    ],
    day: [day],
    LINE_DIVISOR: [divisor],
  };
}

export { S };
