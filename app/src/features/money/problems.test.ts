import {
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import {
  type AbiItem,
  abiTypeOf,
  signatureOf,
} from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { describe, expect, it } from "vitest";
import { dollarsPhrase } from "./copy";
import {
  POT_ERROR_NAMES,
  type PotAction,
  potFallback,
  potProblem,
  potRefusalOf,
} from "./problems";
import { WalletStepError } from "./wallet";

// The task book's refusals bubble through the Treasury, so the book's ABI is read as well as the Treasury's.
const ABIS = [
  TREASURY_ABI,
  TASK_BOOK_ABI,
  VESTER_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  SHARE_TOKEN_ABI,
  PLAY_DOLLAR_ABI,
];

const ACTIONS: PotAction[] = [
  "back",
  "take-out",
  "take-out-team",
  "check-in",
  "draw",
  "rate",
  "door",
  "grant",
  "claim",
  "forfeit",
  "faucet",
  "launch",
  "claim-note",
  "connect",
];

/** Every custom error in the seven ABIs, as the generated file has them. */
const ERRORS: AbiItem[] = ABIS.flatMap((abi) =>
  (abi as readonly AbiItem[]).filter((item) => item.type === "error"),
);

/** Revert data for an error, its arguments filled with a small number or an account. */
function revertData(item: AbiItem): string {
  const inputs = item.inputs ?? [];
  const values = inputs.map((i) =>
    i.type === "address" ? `0x${"0".repeat(39)}1` : 7n,
  );
  return (
    selectorOf(signatureOf(item)) +
    encodeParameters(inputs.map(abiTypeOf), values).slice(2)
  );
}

/** A provider's refusal carrying `data`, wrapped the way the sender reports a send that failed. */
const refused = (data: string) =>
  new WalletStepError("failed", 0, {
    code: -32603,
    message: "execution reverted",
    data: { data },
  });

describe("the words for every refusal of the money contracts", () => {
  it("walks the ABIs: there are errors, and each name has words (and none has words without an error)", () => {
    expect(ERRORS.length).toBeGreaterThan(50);
    const names = new Set(ERRORS.map((e) => e.name));
    expect([...names].sort()).toEqual([...POT_ERROR_NAMES].sort());
  });

  it("says something plain and specific for every error, for every action", () => {
    for (const item of ERRORS)
      for (const action of ACTIONS) {
        const sentence = potProblem(refused(revertData(item)), action);
        const where = `${item.name} while doing ${action}`;
        expect(sentence.length, where).toBeGreaterThan(20);
        expect(sentence, where).toMatch(/[.!]$/);
        // It names what happened for this error, not the line any failure gets.
        expect(sentence, where).not.toBe(potFallback(action));
        // No contract name, code, hex or camel-case word reaches a person.
        expect(sentence, where).not.toContain(item.name as string);
        expect(sentence, where).not.toMatch(/0x[0-9a-f]/i);
        expect(sentence, where).not.toMatch(/[a-z][A-Z]/);
        expect(sentence, where).not.toMatch(/\b(revert|ERC|nsec|wei)\b/i);
        expect(sentence, where).not.toContain("undefined");
        expect(sentence, where).not.toContain("NaN");
      }
  });

  it("reads each error back from its own data", () => {
    for (const item of ERRORS)
      expect(potRefusalOf(refused(revertData(item)))?.name).toBe(item.name);
  });

  it("puts the amounts of a refusal into the sentence in dollars, and a time as a time", () => {
    const belowMinimum = ERRORS.find((e) => e.name === "BelowMinimum");
    if (!belowMinimum) throw new Error("BelowMinimum is gone from the ABI");
    const data =
      selectorOf(signatureOf(belowMinimum)) +
      encodeParameters(["uint256", "uint256"], [1_000_000n, 500_000n]).slice(2);
    expect(potProblem(refused(data), "back")).toContain(
      "back with, 1 dollar. Nothing",
    );
    const notYet = ERRORS.find(
      (e) => e.name === "NotYet" && e.inputs?.length === 1,
    ) as AbiItem;
    const later =
      selectorOf(signatureOf(notYet)) +
      encodeParameters(["uint256"], [1_795_089_600n]).slice(2);
    expect(potProblem(refused(later), "rate")).toMatch(
      /applied from \d+ \w+, \d\d:\d\d/,
    );
  });

  it("finds a refusal the node spelled out in words, and not a passkey prompt that was closed", () => {
    expect(
      potProblem(new Error("execution reverted: DoorShut()"), "back"),
    ).toMatch(/not taking new backers/);
    const closed = new WalletStepError("failed", 0, {
      name: "NotAllowedError",
      message: "The operation either timed out or was not allowed.",
    });
    expect(potRefusalOf(closed.cause)).toBeNull();
  });

  it("says no in the person's own words, and says nothing was sent", () => {
    expect(
      potProblem(new WalletStepError("failed", 0, { code: 4001 }), "take-out"),
    ).toBe("You said no in your wallet. Nothing was sent.");
  });

  it("keeps the sender's own stops as they are everywhere", () => {
    expect(potProblem(new WalletStepError("no-wallet", 0), "back")).toMatch(
      /no wallet in this browser/,
    );
    expect(
      potProblem(new WalletStepError("wrong-network", 0), "take-out"),
    ).toMatch(/another network/);
  });

  it("says a sponsor's refusal of the free network fee in words, and that nothing was sent", () => {
    const denied = new WalletStepError("failed", 0, {
      name: "PaymasterDeniedError",
      message: "denied",
    });
    expect(potProblem(denied, "back")).toMatch(
      /free network fee was refused.*Nothing was sent/,
    );
  });

  it("falls back to a plain line for what it does not know, naming the step and promising nothing changed", () => {
    expect(potProblem(new Error("socket hang up"), "take-out")).toBe(
      "Taking out your Shares did not go through. Nothing changed. Try again.",
    );
    expect(potProblem(undefined, "back")).toBe(potFallback("back"));
  });
});

describe("the words for the task book's refusals and what a holder reads of them", () => {
  /** The refusal `name` with these arguments, as a node would hand it back. */
  function refusal(name: string, args: bigint[] = []) {
    const item = ERRORS.find(
      (e) => e.name === name && (e.inputs?.length ?? 0) === args.length,
    );
    if (!item) throw new Error(`${name} is not in the ABIs`);
    const data =
      selectorOf(signatureOf(item)) +
      encodeParameters((item.inputs ?? []).map(abiTypeOf), args).slice(2);
    return refused(data);
  }
  const say = (name: string, action: PotAction, args: bigint[] = []) =>
    potProblem(refusal(name, args), action);

  it("every error of the book is in the table", () => {
    const book = (TASK_BOOK_ABI as readonly AbiItem[]).filter(
      (i) => i.type === "error",
    );
    expect(book.length).toBeGreaterThan(10);
    for (const item of book) expect(POT_ERROR_NAMES).toContain(item.name);
  });

  it("a node's message that carries the selector alone does not hide the arguments in the revert data", () => {
    const data = `${selectorOf("NoticeRunning(uint256)")}${(1_795_089_600).toString(16).padStart(64, "0")}`;
    // The way a node phrases it: the bare selector in the message, the whole revert in `data`.
    const cause = {
      code: 3,
      message: `execution reverted: custom error ${data.slice(0, 10)}`,
      data,
    };
    expect(potRefusalOf(cause)).toEqual({
      name: "NoticeRunning",
      args: [1_795_089_600n],
    });
    expect(
      potProblem(new WalletStepError("reverted", 0, cause), "claim-note"),
    ).toBe(say("NoticeRunning", "claim-note", [1_795_089_600n]));
    expect(say("NoticeRunning", "claim-note", [1_795_089_600n])).toMatch(
      /^The notice is still running\. This task can be taken from \d+ \w+, \d\d:\d\d\. Nothing changed\.$/,
    );
  });

  it("claim: what is owed, and what is not", () => {
    expect(say("NotYet", "claim-note", [1_795_089_600n])).toMatch(
      /^This task has not ended yet, so there is nothing to claim\. It ends by /,
    );
    expect(say("NothingToPay", "claim-note")).toBe(
      "There is nothing to claim here: the task was paid in full, or you already claimed. Nothing changed.",
    );
    expect(say("NoSuchTask", "claim-note")).toBe(
      "The network does not know that task. Nothing changed.",
    );
    expect(say("CapReached", "claim-note", [900n, 200n, 1_000n])).toBe(
      "Too much of the project's money has been set aside for tasks recently: 9% of the 10% the limit allows, and this task needs 2%. Nothing was set aside.",
    );
  });

  it("an error with no sentence for a step says its own general one, and another action keeps its words", () => {
    expect(say("NotAllowed", "claim-note")).toMatch(
      /This account may not do this/,
    );
    expect(say("TooMuch", "draw", [2n, 1n])).toMatch(
      /allowance box holds right now/,
    );
    expect(say("NotYet", "rate", [1_795_089_600n])).toMatch(/applied from/);
  });
});

describe("dollarsPhrase", () => {
  it("says 1 dollar for a hair over one dollar, never 1 dollars", () => {
    expect(dollarsPhrase(1_000_000n)).toBe("1 dollar");
    expect(dollarsPhrase(1_009_999n)).toBe("1 dollar");
    expect(dollarsPhrase(2_000_000n)).toBe("2 dollars");
  });
});

describe("the words for a passkey person's refusals", () => {
  it("say 'your account' where a wallet person's say 'your wallet', and say no 'wallet' at all", () => {
    const coin = (sender: "wallet" | "passkey") => {
      const error = new WalletStepError("failed", 0, {
        code: -32000,
        message: "insufficient funds for gas * price + value",
      });
      error.sender = sender;
      return potProblem(error, "back");
    };
    expect(coin("wallet")).toMatch(
      /Your wallet needs a little of the network's own coin/,
    );
    expect(coin("wallet")).not.toMatch(/enough dollars/);
    expect(coin("passkey")).not.toMatch(/wallet/i);
    for (const item of ERRORS)
      for (const action of ACTIONS) {
        const error = refused(revertData(item));
        error.sender = "passkey";
        expect(potProblem(error, action), `${item.name} ${action}`).not.toMatch(
          /wallet/i,
        );
      }
  });
});
