// Contract errors in the shapes wallets really give must read as plain sentences, never a
// raw name, a hex selector or an empty line.
import { describe, expect, it } from "vitest";
import { potProblem } from "./problems";
import { WalletStepError } from "./wallet";

const shapes: Record<string, unknown> = {
  panic: {
    code: -32603,
    message: "execution reverted: Panic(0x11)",
    data: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011",
  },
  errorString: {
    code: -32603,
    message: "execution reverted: ERC20: transfer amount exceeds balance",
  },
  unknownSelector: {
    code: 3,
    message: "execution reverted",
    data: "0xdeadbeef",
  },
  metamaskNested: {
    code: -32603,
    message: "Internal JSON-RPC error.",
    data: { code: 3, message: "execution reverted: TooFewShares", data: "0x" },
  },
  emptyMessage: { message: "" },
  string: "boom",
  nullish: null,
};

describe("refusals in words, whatever shape the wallet gives them", () => {
  for (const [name, raw] of Object.entries(shapes))
    for (const reason of ["reverted", "failed"] as const)
      it(`${name} (${reason}) reads as a sentence`, () => {
        const error = new WalletStepError(reason, 0, raw);
        const words = potProblem(error, "back");
        expect(words.trim().length).toBeGreaterThan(10);
        expect(words).not.toMatch(
          /0x[0-9a-f]{8}|Panic|ERC20|execution reverted|TooFewShares|undefined|\[object/,
        );
      });
});
