// LEGACY (behind the legacy-screens flag): the words of the old design's Team and market screens. The refusals of the new
// contracts are walked in `../money/pot-copy.test.ts`, against the ABIs of `contracts/pot`.
import {
  encodeFunctionData,
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { describe, expect, it } from "vitest";
import { WalletStepError } from "../money/wallet";
import { teamProblem, teamRefusalOf } from "./team-copy";

/** A provider's refusal carrying `data`, wrapped the way the wallet reports a send that failed. */
const refused = (data: string) =>
  new WalletStepError("failed", 0, {
    code: -32603,
    message: "execution reverted",
    data: { data },
  });

/** Revert data for `signature` with zero arguments filled in. */
function revertData(signature: string): string {
  const inputs = signature.slice(signature.indexOf("(") + 1, -1);
  const types = inputs ? inputs.split(",") : [];
  return encodeFunctionData(
    signature,
    types as never,
    types.map((t) => (t === "address" ? `0x${"0".repeat(40)}` : 0n)),
  );
}

describe("team copy", () => {
  it("looks inside the auction's wrapper for the bid rule that refused", () => {
    const inner = revertData("BidTooLate(uint256,uint256)");
    const wrapped =
      selectorOf("ValidationHookCallFailed(bytes)") +
      encodeParameters(["bytes"], [inner]).slice(2);
    expect(teamRefusalOf({ data: wrapped })).toBe("BidTooLate");
    expect(teamProblem(refused(wrapped), "bid")).toBe(
      "The auction takes no bids in its last stretch. Nothing was taken.",
    );
  });

  it("says which signer may confirm, and that a wallet's no sent nothing", () => {
    expect(teamProblem(refused(revertData("NotAllowed()")), "confirm")).toMatch(
      /Only the other signer/,
    );
    expect(
      teamProblem(new WalletStepError("failed", 0, { code: 4001 }), "give"),
    ).toBe("You said no in your wallet. Nothing was sent.");
    expect(teamProblem(new WalletStepError("no-wallet", 0), "bid")).toMatch(
      /no wallet in this browser/,
    );
  });
});
