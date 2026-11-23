/**
 * What a call waiting in a Pair says it will do, in a sentence the second signer can say yes to, with the names and the
 * exact addresses and numbers in it. A call is named from the project's own contracts by decoding its calldata with their
 * ABIs: a call to anywhere else, or one this app has no sentence for, is "unknown" and is never confirmed from here.
 */
import { type Abi, decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import type { DecodedValue } from "@creaton/core/launchpad/evmAbi.ts";
import type { ProjectNumbers } from "../money/numbers";
import { durationWords } from "../tasks/chain/duration";
import { isPastEnd, phaseOf } from "../tasks/chain/state";
import type { ChainTaskNow, NoticeFor } from "../tasks/chain/types";
import {
  acceptTaskWords,
  announceTaskWords,
  cancelTaskWords,
  DATE_COUNTS_FROM_CONFIRM,
  pairTaskMoved,
  rejectTaskWords,
  theTaskWords,
  UNKNOWN_TASK_WORDS,
} from "../tasks/chain/words";
import { rateWords, sharesWords, smallDollarsText } from "./pot-words";

type PairCallKind =
  | "draw"
  | "rate-lower"
  | "rate-raise"
  | "rate-apply"
  | "grant"
  | "door"
  | "hand-over"
  | "wind-down"
  | "forfeit"
  | "agent"
  | "announce-task"
  | "accept-task"
  | "reject-task"
  | "cancel-task"
  | "unknown";

export interface Terms {
  kind: PairCallKind;
  /** The sentence the second signer reads. */
  words: string;
  /** Every account the sentence names, lowercased, so the screen can show each in full. */
  names: string[];
  /** Lines under the sentence that are not part of it (the date a plan counts from, the words of the task). */
  more?: string[];
}

/**
 * What the network says, read when a waiting call is shown, for the four task calls (plan section 4.7). Without it, a call
 * that names a task is never read out: its sentence needs the task as it is now, and a guess is never shown.
 */
export interface PairTaskFacts {
  /** The task as the network has it now; null when it could not be read. */
  taskFacts: (serial: bigint) => ChainTaskNow | null;
  /** What a plan of this share gets (the notice, the time to take it, the time it is due after); null when not read. */
  noticeFor: (shareBps: number) => NoticeFor | null;
  /** The network's clock, in seconds. */
  now: number;
  /** The team's own words for the task record with this id (`what`), when this project has one. */
  recordWords: (what: string) => string | null;
}

export const UNKNOWN_WORDS =
  "A call this app cannot read. It is not shown here as something you can confirm. Ask the other signer what it does, or look at it in a block explorer, and confirm it from there if you are sure.";

const unknown = (): Terms => ({
  kind: "unknown",
  words: UNKNOWN_WORDS,
  names: [],
});

const address = (v: DecodedValue | undefined): string =>
  typeof v === "string" ? v.toLowerCase() : "";
const big = (v: DecodedValue | undefined): bigint =>
  typeof v === "bigint" ? v : 0n;

/** "about 7 days" for the project's time unit. */
function unitDays(numbers: ProjectNumbers): string {
  const days = Math.max(1, Math.round(numbers.unit / 86_400));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** An accepted task that is owed pay, as the project's page records it: its words and the two people the record names. */
export interface OwedTask {
  name: string;
  /** Who marked the work accepted. */
  acceptedBy: string;
  /** Who took the task and did the work. */
  takenBy: string;
}

/**
 * "..., the pay for the task "X", as the project's page records it (accepted by A, taken by B)" when a draw is exactly the
 * pay an accepted task still owes (`tasksFor` gives the tasks owed that much, at that wallet). It is the page's own
 * record, shown with who wrote it: a task's author and the person who accepted it can be the one who asks for the draw.
 */
function forTask(tasks: readonly OwedTask[]): string {
  const said = tasks.map(
    (t) => `"${t.name}" (accepted by ${t.acceptedBy}, taken by ${t.takenBy})`,
  );
  if (said.length === 0) return "";
  return said.length === 1
    ? `, the pay for the task ${said[0]}, as the project's page records it`
    : `, the pay for one of these tasks, as the project's page records them: ${said.join("; ")}`;
}

const unknownTask = (): Terms => ({
  kind: "unknown",
  words: UNKNOWN_TASK_WORDS,
  names: [],
});

const ZERO = /^0x0{40}$/;

/** "Plan a task: ..." with the notice read from the network and a second line that the date counts from the confirming. */
function announceTerms(
  args: readonly DecodedValue[],
  who: (address: string) => string,
  facts: PairTaskFacts | undefined,
): Terms {
  const shareBps = Number(big(args[3]));
  const notice = facts?.noticeFor(shareBps) ?? null;
  if (!facts || !notice) return unknownTask();
  const payee = address(args[1]);
  const open = ZERO.test(payee);
  const words = facts.recordWords(String(args[0]).toLowerCase());
  return {
    kind: "announce-task",
    words: announceTaskWords({
      max: big(args[2]),
      who: open ? null : who(payee),
      shareBps,
      notice: durationWords(notice.noticeSecs),
      from: facts.now + notice.noticeSecs,
      window: durationWords(notice.takeWindowSecs),
      due: durationWords(notice.dueSecs),
    }),
    names: open ? [] : [payee],
    more: [DATE_COUNTS_FROM_CONFIRM, ...(words ? [theTaskWords(words)] : [])],
  };
}

/** Pay, send back or withdraw task `serial`: said from the task as the network has it now, never from the call alone. */
function taskCallTerms(
  signature: string,
  args: readonly DecodedValue[],
  who: (address: string) => string,
  facts: PairTaskFacts | undefined,
): Terms {
  const serial = big(args[0]);
  const task = facts?.taskFacts(serial) ?? null;
  if (!facts || !task) return unknownTask();
  // The sentence says what the call does to a task in one state; a task in another state would be refused, so it is said so.
  const wants = signature === "cancelTask(uint64)" ? "announced" : "taken";
  // A task past its end is ended by the contract's next step first, so the call would be refused: it is said so, not offered.
  if (
    task.state !== wants ||
    (wants === "taken" && task.takenBy === null) ||
    isPastEnd(task, facts.now)
  )
    return {
      kind: "unknown",
      words: pairTaskMoved(serial, phaseOf(task, facts.now)),
      names: [],
    };
  const words = facts.recordWords(task.what);
  const more = words ? [theTaskWords(words)] : undefined;
  const base = { names: [] as string[], ...(more ? { more } : {}) };
  if (signature === "rejectTask(uint64)")
    return { kind: "reject-task", words: rejectTaskWords(serial), ...base };
  if (signature === "cancelTask(uint64)")
    return { kind: "cancel-task", words: cancelTaskWords(serial), ...base };
  const taker = task.takenBy ?? "";
  return {
    kind: "accept-task",
    words: acceptTaskWords({
      pay: big(args[1]),
      setAside: task.setAside,
      serial,
      who: who(taker),
    }),
    ...base,
    names: [taker],
  };
}

export function describePotCall(
  numbers: ProjectNumbers,
  target: string,
  data: string,
  nameOf: (address: string) => string,
  tasksFor: (payee: string, raw: bigint) => readonly OwedTask[] = () => [],
  facts?: PairTaskFacts,
): Terms {
  const t = target.toLowerCase();
  const abi: Abi | null =
    t === numbers.contracts.treasury
      ? TREASURY_ABI
      : t === numbers.launcher
        ? LAUNCHER_ABI
        : null;
  if (!abi) return unknown();
  let call: ReturnType<typeof decodeCall>;
  try {
    call = decodeCall(abi, data);
  } catch {
    return unknown();
  }
  if (!call) return unknown();
  const who = (a: string) => `${nameOf(a)} (${a})`;
  const { args } = call;
  try {
    if (abi === TREASURY_ABI) {
      switch (call.signature) {
        case "draw(address,uint256)": {
          const to = address(args[0]);
          return {
            kind: "draw",
            words: `Draw ${smallDollarsText(big(args[1]))} dollars from the allowance box to ${who(to)}${forTask(tasksFor(to, big(args[1])))}.`,
            names: [to],
          };
        }
        case "setRate(uint32)":
          return {
            kind: "rate-lower",
            words: `Lower the daily allowance to ${rateWords(Number(big(args[0])))} of the project's money a day, at once.`,
            names: [],
          };
        case "proposeRate(uint32)":
          return {
            kind: "rate-raise",
            words: `Announce a higher daily allowance of ${rateWords(Number(big(args[0])))} of the project's money a day. It can be applied ${unitDays(numbers)} after it is announced, and everyone can see it first.`,
            names: [],
          };
        case "applyRate()":
          return {
            kind: "rate-apply",
            words:
              "Apply the announced daily allowance now that its wait is over.",
            names: [],
          };
        case "grantTeam(address,uint256)": {
          const member = address(args[0]);
          return {
            kind: "grant",
            words: `Grant ${sharesWords(big(args[1]))} Team Shares to ${who(member)}. The grant has its own clock: it starts unlocking after about ${Math.round((numbers.limits.cliffUnits * numbers.unit) / 86_400)} days of the team checking in. Team Shares claim only the project's money above what backers put in.`,
            names: [member],
          };
        }
        case "setDoor(bool)":
          return {
            kind: "door",
            words:
              args[0] === true
                ? "Open the door to new backing."
                : "Close the door to new backing. People can still take their money out.",
            names: [],
          };
        case "handOver(address,bool)": {
          const next = address(args[0]);
          // The zero address withdraws an offer of the seat.
          if (/^0x0{40}$/.test(next))
            return {
              kind: "hand-over",
              words:
                "Withdraw the offer of the seat that runs the project. Whoever it was offered to can no longer take it; nothing else changes.",
              names: [],
            };
          return {
            kind: "hand-over",
            words: `Offer the seat that runs the project to ${who(next)}${args[1] === true ? ". The founder leaves and gives up the part of their own Team Shares they have not built up" : ""}.`,
            names: [next],
          };
        }
        case "authoriseAgent(address)": {
          const agent = address(args[0]);
          return {
            kind: "agent",
            words: `Let ${who(agent)} act as a helper, with Creaton's usual daily limits on what it can draw.`,
            names: [agent],
          };
        }
        case "setAgent(address,uint128,uint128)": {
          const agent = address(args[0]);
          return {
            kind: "agent",
            words: `Set the daily limits of the helper ${who(agent)}: up to ${smallDollarsText(big(args[1]))} dollars from the allowance box and ${sharesWords(big(args[2]))} Team Shares a day.`,
            names: [agent],
          };
        }
        case "revokeAgent(address)": {
          const agent = address(args[0]);
          return {
            kind: "agent",
            words: `Switch off the helper ${who(agent)}.`,
            names: [agent],
          };
        }
        case "announceForfeit(uint256)":
          // What a Pair can hold for a member's grant: a call on the Treasury (it passes it on to the Vester itself).
          return {
            kind: "forfeit",
            words: `Announce that the part of Team Share grant number ${big(args[0])} that has not unlocked is removed after a public notice of ${unitDays(numbers)}. The person keeps what has unlocked.`,
            names: [],
          };
        case "announceTask(bytes32,address,uint256,uint16)":
          return announceTerms(args, who, facts);
        case "acceptTask(uint64,uint256)":
        case "rejectTask(uint64)":
        case "cancelTask(uint64)":
          return taskCallTerms(call.signature, args, who, facts);
        default:
          return unknown();
      }
    }
    if (abi === LAUNCHER_ABI && call.signature === "windDown(bytes32)") {
      if (String(args[0]).toLowerCase() !== numbers.key.toLowerCase())
        return unknown();
      return {
        kind: "wind-down",
        words:
          "Wind the project down, for good. The allowance box goes back to the project's money, nobody can back it any more, and the Team Shares that nobody has built up yet are removed after a notice. People who hold Shares can still take their money out.",
        names: [],
      };
    }
  } catch {
    return unknown();
  }
  return unknown();
}
