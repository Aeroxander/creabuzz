import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import { describe, expect, it } from "vitest";
import { moneyProblem, refusalOf } from "./money-copy";
import { WalletStepError } from "./wallet";

const revert = (signature: string) => ({
  code: -32603,
  message: "execution reverted",
  data: { data: `${selectorOf(signature)}${"0".repeat(64)}` },
});

describe("money copy", () => {
  it("finds the contract's refusal by its selector or its name", () => {
    expect(refusalOf(revert("WrongPhase()"))).toBe("WrongPhase");
    expect(refusalOf(revert("CapReached(uint256)"))).toBe("CapReached");
    expect(
      refusalOf(revert("ERC20InsufficientBalance(address,uint256,uint256)")),
    ).toBe("NotEnoughDollars");
    expect(
      refusalOf({ message: "reverted with custom error NothingToRefund()" }),
    ).toBe("NothingToRefund");
    expect(refusalOf({ message: "network down" })).toBeNull();
  });

  it("says each refusal in plain words, by what the person was doing", () => {
    const failed = (sig: string, landed = 0) =>
      new WalletStepError("failed", landed, revert(sig));
    expect(moneyProblem(failed("WrongPhase()"), "back")).toMatch(
      /not taking asks/,
    );
    expect(moneyProblem(failed("WrongPhase()"), "refund")).toMatch(
      /once the round has closed/,
    );
    expect(moneyProblem(failed("NotAllowed()"), "check-in")).toBe(
      "Only the person who runs the project can check in.",
    );
    expect(moneyProblem(failed("NothingToRefund()"), "refund")).toMatch(
      /nothing left to take back/,
    );
    expect(moneyProblem(failed("BadAmount()"), "back")).toMatch(
      /at least 1 dollar/,
    );
  });

  it("tells a wallet without the network's coin to add some, not dollars (F6)", () => {
    const gas = new WalletStepError("failed", 0, {
      code: -32000,
      message: "insufficient funds for gas * price + value",
    });
    expect(refusalOf(gas.cause)).toBe("NoGas");
    expect(moneyProblem(gas, "back")).toMatch(/network's own coin/);
    expect(moneyProblem(gas, "back")).not.toMatch(/enough dollars/);
    expect(
      refusalOf(revert("ERC20InsufficientAllowance(address,uint256,uint256)")),
    ).toBe("NotEnoughDollars");
  });

  it("says only the account that runs the project can open backing (F5)", () => {
    for (const sig of ["NotRunner()", "WrongRunner(uint8)"]) {
      const error = new WalletStepError("failed", 0, revert(sig));
      expect(refusalOf(error.cause)).toBe("NotRunner");
      expect(moneyProblem(error, "open")).toBe(
        "Only the account that runs this project can open backing. Nothing changed.",
      );
    }
  });

  it("says what a wallet stop means, and what already went through", () => {
    expect(moneyProblem(new WalletStepError("no-wallet", 0), "back")).toMatch(
      /no wallet in this browser/,
    );
    expect(
      moneyProblem(
        new WalletStepError("failed", 1, {
          code: 4001,
          message: "User denied",
        }),
        "back",
      ),
    ).toBe("You said no in your wallet after the approval. Nothing was taken.");
    expect(
      moneyProblem(new WalletStepError("failed", 0, { code: 4001 }), "refund"),
    ).toBe("You said no in your wallet. Nothing was sent.");
    expect(moneyProblem(new WalletStepError("pending", 1), "back")).toMatch(
      /not landed yet/,
    );
    expect(moneyProblem(new WalletStepError("failed", 1), "back")).toMatch(
      /approval went through but the backing did not/,
    );
  });

  it("never shows a refusal name, a code or a hex value", () => {
    const actions = ["back", "refund", "take-out", "check-in", "open"] as const;
    const errors = [
      new WalletStepError("failed", 0, revert("TokenMisbehaved()")),
      new WalletStepError("reverted", 0),
      new WalletStepError("wrong-network", 0),
      new Error("execution reverted: 0xdeadbeef"),
    ];
    for (const action of actions)
      for (const error of errors) {
        const text = moneyProblem(error, action);
        expect(text).not.toMatch(/0x|revert|Misbehaved|-326|4001/);
        expect(text).not.toMatch(/\bearn/i);
      }
  });
});
