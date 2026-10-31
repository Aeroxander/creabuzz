/**
 * What a DAO actually guarantees a holder who is outvoted, read from the chain rather than assumed (the Powers card):
 * whether leaving is on, whether it is permanent, and how long a decision waits under today's settings.
 *
 * - Leaving is permanent only in DAOs made after D73, which removed the switch and the vote-made burns; those answer
 *   `leaving()`. An older DAO, or one summoned with leaving off, does not get that line.
 * - The wait is a setting, not a floor: `AllocationVoting.setLane` allows a review of one day and no hold, and the DAO's
 *   `setTimelockDelay` one second. Each decision keeps the review, hold and delay in force when it opened
 *   (`AllocationVoting.Rules`, `executionDelay`), so a change only reaches decisions opened after it. The card states
 *   today's numbers and that a vote can shorten them for later decisions.
 *
 * Pure apart from the injected `call`: `dao-guarantees.test.mjs` drives it with a fake chain. A network that does not
 * answer is an error, never a guarantee.
 */

import { span } from "./challenge-copy.ts";

/** One `eth_call`: the raw return data, or a thrown error. */
export type Call = (to: string, data: string) => Promise<string>;

const LEAVING = "0xaf56f7dc"; // leaving()
const RAGEQUITTABLE = "0x14a6d7de"; // ragequittable()
const TIMELOCK_DELAY = "0xeef09bad"; // timelockDelay()
const LANES = "0x713c311a"; // lanes(uint256): quorumBps, approvalBps, review, hold, exclusive

/** The shortest wait, in seconds, from a decision opening to it running: its lane's review, then the DAO's delay. */
export interface Notice {
  /** Anything that spends the treasury or changes the rules (the full vote). */
  full: number;
  /** An award or a project inside a budget already voted (the bounded vote). */
  bounded: number;
}

/** What a DAO launched by the kit starts with: a 48-hour review plus a 1-day delay, and 24 hours plus a day. */
export const DEFAULT_NOTICE: Notice = { full: 3 * 86_400, bounded: 2 * 86_400 };

export interface DaoGuarantees {
  /** Made after D73: no vote can switch leaving off or burn a holder's Shares. */
  leavingPermanent: boolean;
  /** Members can leave with their share of the treasury at all. */
  ragequittable: boolean;
  /** Today's settings; a vote can shorten them for decisions opened later. */
  notice: Notice;
}

const isRefusal = (error: unknown) =>
  error instanceof Error && /revert/i.test(error.message);

function words(hex: string, count: number): bigint[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < count * 64 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error("expected an ABI answer");
  }
  return Array.from({ length: count }, (_, i) =>
    BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`),
  );
}

const indexWord = (i: number) => i.toString(16).padStart(64, "0");

export async function readDaoGuarantees(
  call: Call,
  dao: string,
  policy: string,
): Promise<DaoGuarantees> {
  let leavingPermanent: boolean;
  try {
    words(await call(dao, LEAVING), 1);
    leavingPermanent = true;
  } catch (error) {
    if (!isRefusal(error)) throw error;
    leavingPermanent = false;
  }
  const [ragequittable, delay, full, bounded] = await Promise.all([
    call(dao, RAGEQUITTABLE),
    call(dao, TIMELOCK_DELAY),
    call(policy, `${LANES}${indexWord(0)}`),
    call(policy, `${LANES}${indexWord(1)}`),
  ]);
  const timelock = Number(words(delay, 1)[0]);
  const review = (lane: string) => Number(words(lane, 5)[2]);
  return {
    leavingPermanent,
    ragequittable: words(ragequittable, 1)[0] !== 0n,
    notice: {
      full: review(full) + timelock,
      bounded: review(bounded) + timelock,
    },
  };
}

/**
 * The notice in one paragraph: today's numbers (or, before the DAO exists, the ones it will start with), and that they are
 * settings a vote can shorten for later decisions, to as little as a day, by a decision that itself waits today's notice.
 */
export function noticeText(notice: Notice, of: "dao" | "plan"): string {
  const numbers = `at least ${span(notice.full)} for anything that spends the treasury or changes the rules, ${span(notice.bounded)} for an award or a project inside a budget already voted`;
  const opening =
    of === "dao"
      ? `With this DAO's settings today, every decision waits before it takes effect: ${numbers}.`
      : `The DAO starts out with every decision waiting ${numbers}.`;
  return `${opening} These are settings, not promises: each decision keeps the waits in force when it opens, but a vote can shorten them for decisions opened later, to as little as a day, and that vote itself waits the notice in force when it is opened.`;
}
