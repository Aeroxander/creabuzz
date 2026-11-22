/**
 * The Council's waiting calls, read from the chain (the record of numbers carries only counts, never bytes): each
 * `Proposed` log decoded into its exact (target, data, nonce), which `agree` needs, and the inner call described in plain
 * words — the same sentences the Pair's confirm sheet uses (`team/pair.ts`, `describeProposal`), extended with the Council's
 * other actions (draw, check in, the rate, the door, a task, a grant, a helper). Pure.
 *
 * The events are the same shape as a Pair's (`Proposed(bytes32,address,address,bytes,uint256)`), so one reader serves both;
 * the Council adds `Agreed`, `Withdrawn`, `Executed` and `Cancelled`, which say which proposals still wait and how many
 * seats have agreed. The proposal's life is a clock the logs do not carry: the list therefore says only what the events
 * say, and the screens cap it at the record's own `council.waiting` count.
 */
import {
  decodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import {
  abiTypeOf,
  functionOf,
  signatureOf,
} from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { dollarsText, sharesText } from "../money/numbers";
import type { ChainLog } from "../money/wallet";

/** The same event a Pair writes: `Proposed(bytes32 indexed id, address indexed by, address target, bytes data, uint256 nonce)`. */
export const PROPOSED_TOPIC = topicOf(
  "Proposed(bytes32,address,address,bytes,uint256)",
);

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * A `Proposed` log as a proposal, or null when it is not one this Council wrote. The Pair's own reader
 * (`team/pair.ts`) decodes the same event; it is behind the old-screens flag, so this live module carries its own copy of
 * the two things it needs (this decoder and the sentences for a hand-over and a wind-down), word for word the same.
 */
export function proposalOf(
  log: ChainLog,
  council: string,
): CouncilProposal | null {
  if (log.address.toLowerCase() !== council.toLowerCase()) return null;
  const [topic, id, by] = log.topics.map((t) => t.toLowerCase());
  if (topic !== PROPOSED_TOPIC || !id || !by) return null;
  if (!HEX32.test(id) || !HEX32.test(by)) return null;
  try {
    const [target, data, nonce] = decodeParameters(
      ["address", "bytes", "uint256"],
      log.data,
    );
    if (typeof target !== "string" || typeof data !== "string") return null;
    if (typeof nonce !== "bigint") return null;
    return {
      id,
      by: `0x${by.slice(26)}`,
      target: target.toLowerCase(),
      data: data.toLowerCase(),
      nonce,
      block: Number.parseInt(log.blockNumber, 16) || 0,
    };
  } catch {
    return null;
  }
}

const AGREED_TOPIC = topicOf("Agreed(bytes32,address,uint8)");
const WITHDRAWN_TOPIC = topicOf("Withdrawn(bytes32,address,uint8)");
const EXECUTED_TOPIC = topicOf("Executed(bytes32,address)");
const CANCELLED_TOPIC = topicOf("Cancelled(bytes32)");

/** The actions a Council's waiting list can name, in the record's own words (`council.waiting.kinds`). */
export type CouncilAction =
  | "draw"
  | "checkIn"
  | "rate"
  | "door"
  | "plan"
  | "accept"
  | "reject"
  | "cancel"
  | "grant"
  | "helper"
  | "handOver"
  | "windDown"
  | "other";

/** One of the Council's calls, as the app names it. */
export interface CouncilProposal {
  id: string;
  by: string;
  target: string;
  data: string;
  nonce: bigint;
  block: number;
}

/** A proposal that may still run, with how many seats have agreed to it. */
export interface WaitingAction extends CouncilProposal {
  kind: CouncilAction;
  /** The call in plain words, for the row a seat holder agrees to. */
  words: string;
  /** The account the call names, when it names one. */
  names: string | null;
  /** How many seats have agreed so far (the record's `council.needed` is what it needs). */
  agreed: number;
}

/** Every `Proposed` log of `council`, newest first. Not a proposal's log and not this Council's are ignored. */
export function councilProposals(
  logs: readonly ChainLog[],
  council: string,
): CouncilProposal[] {
  return logs
    .map((log) => proposalOf(log, council))
    .filter((proposal): proposal is NonNullable<typeof proposal> =>
      Boolean(proposal),
    )
    .sort((a, b) => b.block - a.block);
}

/** One call the Council may take, named by its contract's own ABI: no signature or selector is typed by hand. */
interface ActionDef {
  readonly answer: CouncilAction;
  readonly abi: readonly { readonly type: string; readonly name?: string }[];
  readonly name: string;
}

const ACTIONS: readonly ActionDef[] = [
  { answer: "draw", abi: TREASURY_ABI, name: "draw" },
  { answer: "checkIn", abi: TREASURY_ABI, name: "checkIn" },
  { answer: "rate", abi: TREASURY_ABI, name: "setRate" },
  { answer: "rate", abi: TREASURY_ABI, name: "proposeRate" },
  { answer: "rate", abi: TREASURY_ABI, name: "applyRate" },
  { answer: "door", abi: TREASURY_ABI, name: "setDoor" },
  { answer: "plan", abi: TREASURY_ABI, name: "announceTask" },
  { answer: "accept", abi: TREASURY_ABI, name: "acceptTask" },
  { answer: "reject", abi: TREASURY_ABI, name: "rejectTask" },
  { answer: "cancel", abi: TREASURY_ABI, name: "cancelTask" },
  { answer: "grant", abi: TREASURY_ABI, name: "grantTeam" },
  { answer: "helper", abi: TREASURY_ABI, name: "authoriseAgent" },
  { answer: "helper", abi: TREASURY_ABI, name: "setAgent" },
  { answer: "helper", abi: TREASURY_ABI, name: "revokeAgent" },
  { answer: "handOver", abi: TREASURY_ABI, name: "handOver" },
  { answer: "windDown", abi: LAUNCHER_ABI, name: "windDown" },
  { answer: "windDown", abi: TREASURY_ABI, name: "windDown" },
];

const BY_SELECTOR = new Map(
  ACTIONS.map((def) => [
    selectorOf(signatureOf(functionOf(def.abi, def.name))),
    def,
  ]),
);

/** The action a call is, by its selector; `other` when the app does not know it. */
export function actionOf(data: string): CouncilAction {
  return BY_SELECTOR.get(data.slice(0, 10).toLowerCase())?.answer ?? "other";
}

/** A part per million of the project's money a day as a percent: "0.1%", "0.25%". */
function rateWords(ppm: bigint): string {
  const percent = Number(ppm) / 10_000;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0$/, "")}%`;
}

/** A whole number as "task 3". */
function taskWords(serial: bigint): string {
  return `task ${serial.toString()}`;
}

const NOBODY = "0x0000000000000000000000000000000000000000";

/** The words for a Council call the Pair's own reader does not describe. Never a hex string, never a selector. */
function councilWords(
  data: string,
  nameOf: (address: string) => string,
): { kind: CouncilAction; words: string; names: string | null } | null {
  const def = BY_SELECTOR.get(data.slice(0, 10).toLowerCase());
  if (!def) return null;
  try {
    const fn = functionOf(def.abi, def.name);
    const args = decodeParameters(
      (fn.inputs ?? []).map((input) => abiTypeOf(input as never)),
      `0x${data.slice(10)}`,
    );
    switch (def.name) {
      case "draw": {
        const [to, amount] = args;
        return {
          kind: "draw",
          words: `Draw ${dollarsText(amount as bigint)} dollars from the allowance to ${nameOf(String(to).toLowerCase())}`,
          names: String(to).toLowerCase(),
        };
      }
      case "checkIn":
        return {
          kind: "checkIn",
          words: "Check in for the project",
          names: null,
        };
      case "applyRate":
        return {
          kind: "rate",
          words: "Apply the announced allowance",
          names: null,
        };
      case "setRate":
      case "proposeRate": {
        const percent = rateWords(args[0] as bigint);
        return {
          kind: "rate",
          words:
            def.name === "setRate"
              ? `Change the allowance to ${percent} of the project's money a day`
              : `Announce a higher allowance: ${percent} of the project's money a day, from one time unit later`,
          names: null,
        };
      }
      case "setDoor":
        return {
          kind: "door",
          words: args[0]
            ? "Open the door to new backers"
            : "Shut the door to new backers",
          names: null,
        };
      case "announceTask": {
        const [, payee, maxDollars] = args;
        const forWhom =
          String(payee).toLowerCase() === NOBODY
            ? ""
            : `, for ${nameOf(String(payee).toLowerCase())} only`;
        return {
          kind: "plan",
          words: `Plan a task that may cost up to ${dollarsText(maxDollars as bigint)} dollars${forWhom}`,
          names: null,
        };
      }
      case "acceptTask": {
        const [serial, dollars] = args;
        return {
          kind: "accept",
          words: `Accept ${taskWords(serial as bigint)} and pay ${dollarsText(dollars as bigint)} dollars`,
          names: null,
        };
      }
      case "rejectTask":
        return {
          kind: "reject",
          words: `Send ${taskWords(args[0] as bigint)}'s money back, paying nobody`,
          names: null,
        };
      case "cancelTask":
        return {
          kind: "cancel",
          words: `Cancel planned ${taskWords(args[0] as bigint)}`,
          names: null,
        };
      case "grantTeam": {
        const [to, amount] = args;
        return {
          kind: "grant",
          words: `Grant ${sharesText(amount as bigint)} Team Shares to ${nameOf(String(to).toLowerCase())}`,
          names: String(to).toLowerCase(),
        };
      }
      case "authoriseAgent":
        return {
          kind: "helper",
          words: `Let ${nameOf(String(args[0]).toLowerCase())} act as a helper`,
          names: String(args[0]).toLowerCase(),
        };
      case "revokeAgent":
        return {
          kind: "helper",
          words: `Switch ${nameOf(String(args[0]).toLowerCase())} off as a helper`,
          names: String(args[0]).toLowerCase(),
        };
      case "handOver": {
        const [next, leaves] = args;
        const who = nameOf(String(next).toLowerCase());
        return {
          kind: "handOver",
          words: `Offer the runner seat to ${who}${leaves ? ", and the founder leaves" : ""}`,
          names: String(next).toLowerCase(),
        };
      }
      case "windDown":
        return {
          kind: "windDown",
          words: "Wind the project down, for good",
          names: null,
        };
      case "setAgent": {
        const [agent, usd, team] = args;
        return {
          kind: "helper",
          words: `Set ${nameOf(String(agent).toLowerCase())}'s daily limits: ${dollarsText(usd as bigint)} dollars and ${sharesText(team as bigint)} Team Shares`,
          names: String(agent).toLowerCase(),
        };
      }
      default:
        return null;
    }
  } catch {
    // A call whose arguments do not read as expected is named as unknown, never guessed.
    return null;
  }
}

/**
 * What a proposed call does, in a sentence a person can agree to (the same words the Pair's confirm sheet uses for a
 * hand-over and a wind-down), and who it names when it names someone. A call this app cannot read is named as unknown,
 * never guessed.
 */
export function councilProposalWords(
  data: string,
  nameOf: (address: string) => string,
): { kind: CouncilAction; words: string; names: string | null } {
  const described = councilWords(data, nameOf);
  if (described) return described;
  return {
    kind: "other",
    words:
      "A call this app cannot describe. Look at it in a block explorer before agreeing.",
    names: null,
  };
}

/** The proposal numbers whose state the Council's events changed, and how many seats agreed to each. */
interface Tally {
  agreed: number;
  gone: boolean;
}

function tallies(
  logs: readonly ChainLog[],
  council: string,
): Map<string, Tally> {
  const out = new Map<string, Tally>();
  const at = (id: string) => {
    const found = out.get(id) ?? { agreed: 0, gone: false };
    out.set(id, found);
    return found;
  };
  for (const log of logs) {
    if (log.address.toLowerCase() !== council.toLowerCase()) continue;
    const [topic, id] = log.topics.map((t) => t.toLowerCase());
    if (!topic || !id || id.length !== 66) continue;
    try {
      if (topic === AGREED_TOPIC) {
        const [count] = decodeParameters(["uint8"], log.data);
        at(id).agreed = Math.max(at(id).agreed, Number(count));
      } else if (topic === WITHDRAWN_TOPIC) {
        const [count] = decodeParameters(["uint8"], log.data);
        const found = at(id);
        found.agreed = Number(count);
        // Back to nothing: the proposal waits for its proposer's own first agreement no more.
        if (Number(count) === 0) found.gone = true;
      } else if (topic === EXECUTED_TOPIC || topic === CANCELLED_TOPIC) {
        at(id).gone = true;
      }
    } catch {
      // A log whose data does not read as expected changes nothing; the list catches up from the record.
    }
  }
  return out;
}

/**
 * The calls still waiting for a seat holder's agreement: proposed, not executed or cancelled, taken back to nothing, with
 * at least one seat's agreement, at most `limit` of them and newest first. What it cannot see is the proposal's clock (the
 * logs do not carry a time): the screens cap the list at the record's own `council.waiting` count and let it catch up.
 */
export function waitingActions(input: {
  logs: readonly ChainLog[];
  council: string;
  nameOf: (address: string) => string;
  limit?: number;
}): WaitingAction[] {
  const counts = tallies(input.logs, input.council);
  const waiting: WaitingAction[] = [];
  for (const proposal of councilProposals(input.logs, input.council)) {
    const tally = counts.get(proposal.id);
    if (tally?.gone) continue;
    // A proposal counts its proposer's own agreement from the moment it is made: `Proposed` says it, and no `Agreed`
    // event is written for that first agreement. A later `Withdrawn` carries the count after it, so a real zero still
    // takes the call off the list.
    const agreed = tally?.agreed ?? 1;
    if (agreed === 0) continue;
    const described = councilProposalWords(proposal.data, input.nameOf);
    waiting.push({
      ...proposal,
      kind: described.kind,
      words: described.words,
      names: described.names,
      agreed,
    });
  }
  return input.limit === undefined ? waiting : waiting.slice(0, input.limit);
}
