/**
 * What a call waiting in a Pair says it will do, in a sentence the second signer can say yes to, with the names and the
 * exact addresses and numbers in it. A call is named from the project's own contracts by decoding its calldata with their
 * ABIs: a call to anywhere else, or one this app has no sentence for, is "unknown" and is never confirmed from here.
 */
import { type Abi, decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import type { DecodedValue } from "@creaton/core/launchpad/evmAbi.ts";
import { dollarsText, type ProjectNumbers } from "../money/numbers";
import { rateWords, sharesWords } from "./pot-words";

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
  | "unknown";

export interface Terms {
  kind: PairCallKind;
  /** The sentence the second signer reads. */
  words: string;
  /** Every account the sentence names, lowercased, so the screen can show each in full. */
  names: string[];
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

export function describePotCall(
  numbers: ProjectNumbers,
  target: string,
  data: string,
  nameOf: (address: string) => string,
): Terms {
  const t = target.toLowerCase();
  const abi: Abi | null =
    t === numbers.contracts.treasury
      ? TREASURY_ABI
      : t === numbers.contracts.vester
        ? VESTER_ABI
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
            words: `Draw ${dollarsText(big(args[1]))} dollars from the allowance box to ${who(to)}.`,
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
          return {
            kind: "hand-over",
            words: `Offer the seat that runs the project to ${who(next)}${args[1] === true ? ". The founder leaves and gives up what has not unlocked of their own Team Shares" : ""}.`,
            names: [next],
          };
        }
        case "authoriseAgent(address)": {
          const agent = address(args[0]);
          return {
            kind: "agent",
            words: `Let ${who(agent)} act as a helper, with the platform's usual daily limits on what it can draw.`,
            names: [agent],
          };
        }
        case "setAgent(address,uint128,uint128)": {
          const agent = address(args[0]);
          return {
            kind: "agent",
            words: `Set the daily limits of the helper ${who(agent)}: up to ${dollarsText(big(args[1]))} dollars from the allowance box and ${sharesWords(big(args[2]))} Team Shares a day.`,
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
        default:
          return unknown();
      }
    }
    if (abi === VESTER_ABI && call.signature === "announceByRunner(uint256)")
      return {
        kind: "forfeit",
        words: `Announce that the part of Team Share grant number ${big(args[0])} that has not unlocked is removed after a public notice of ${unitDays(numbers)}. The person keeps what has unlocked.`,
        names: [],
      };
    if (abi === LAUNCHER_ABI && call.signature === "windDown(bytes32)") {
      if (String(args[0]).toLowerCase() !== numbers.key.toLowerCase())
        return unknown();
      return {
        kind: "wind-down",
        words:
          "Wind the project down, for good. The allowance box goes back to the project's money, nobody can back it any more, and Team Shares that have not unlocked are removed after a notice. People who hold Shares can still take their money out.",
        names: [],
      };
    }
  } catch {
    return unknown();
  }
  return unknown();
}
