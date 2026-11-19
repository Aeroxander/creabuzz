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
  TREASURY_ABI,
  VESTER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { describe, expect, it } from "vitest";
import {
  POT_ERROR_NAMES,
  type PotAction,
  potFallback,
  potProblem,
  potRefusalOf,
} from "./pot-copy";
import { WalletStepError } from "./wallet";

const ABIS = [
  TREASURY_ABI,
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
  "revenue",
  "faucet",
  "agent",
  "seat",
  "launch",
  "wind-down",
  "pair",
];

/** Every custom error in the six ABIs, as the generated file has them. */
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

  it("falls back to a plain line for what it does not know, naming the step and promising nothing changed", () => {
    expect(potProblem(new Error("socket hang up"), "take-out")).toBe(
      "Taking out your Shares did not go through. Nothing changed. Try again.",
    );
    expect(potProblem(undefined, "back")).toBe(potFallback("back"));
  });
});
