import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  encodeFunctionData,
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { describe, expect, it } from "vitest";
import { WalletStepError } from "../money/wallet";
import { type TeamAction, teamProblem, teamRefusalOf } from "./team-copy";

/**
 * Every error in the ABIs of the contracts Team and the market call, as the build (`contracts/next/out`) lists them. The
 * last test checks this copy against the build when the build is on disk.
 */
const ABI_ERRORS: Record<string, string[]> = {
  "Pair.sol/Pair.json": [
    "BadSetup()",
    "BadTarget()",
    "CapAmountTooLarge()",
    "CapExceeded(uint256,uint256,uint256)",
    "NotAllowed()",
    "UnknownCall()",
  ],
  "Launcher.sol/Launcher.json": [
    "BadCut()",
    "BadName()",
    "BadSettings()",
    "BadStack()",
    "BadStart()",
    "CapReached(uint256)",
    "FailedDeployment()",
    "InsufficientBalance(uint256,uint256)",
    "NoPoolGuard()",
    "NotAdmin()",
    "NotCouncilMaker()",
    "NotRunner()",
    "ProjectExists()",
    "SettingsMoved()",
    "TooEarly(uint256)",
    "UnknownProject()",
    "WrongRunner(uint8)",
    "WrongStage()",
  ],
  "Treasury.sol/Treasury.json": [
    "AlreadyWoundDown()",
    "BadInput()",
    "BadSetup()",
    "CapAmountTooLarge()",
    "CapExceeded(uint256,uint256,uint256)",
    "NoPool()",
    "NotAbandoned()",
    "NotAllowed()",
    "NotArrived(uint256,uint256)",
    "NotSettled()",
    "NothingToPay()",
    "PoolAlreadyOpen()",
    "Reentrancy()",
    "ReserveSaleState()",
    "SafeERC20FailedOperation(address)",
    "SaleAlreadyClosed()",
    "SaleNotClosed()",
    "TeamBudgetShort(uint256,uint256)",
    "TeamPayTooFast(uint256,uint256)",
    "TokenMisbehaved()",
    "TooMuch(uint256,uint256)",
    "WorkPotShort(uint256,uint256)",
  ],
  "Finisher.sol/Finisher.json": [
    "BadSetup()",
    "CannotOpen()",
    "MoneyMissing(uint256,uint256)",
    "NoPool()",
    "NotLauncher()",
    "PoolExists()",
    "PoolStepNotRun()",
    "Reentrancy()",
    "SafeERC20FailedOperation(address)",
    "SaleDidNotGraduate()",
    "SettleFirst()",
    "TooEarly(uint256)",
    "WrongStage()",
  ],
  "EarlierBackers.sol/EarlierBackers.json": [
    "BadHolder()",
    "BadReceiver()",
    "BadSetup()",
    "BadSignature()",
    "Barred()",
    "BindState()",
    "ClosedState()",
    "EntryState()",
    "Expired()",
    "NoReplacement()",
    "NotFunded()",
    "NotKeeper()",
    "NotOnList()",
    "OverTotal()",
    "TextMoved()",
    "TooEarly(uint256)",
    "UnknownEntry()",
    "WindowOver()",
  ],
  "MinBid.sol/MinBid.json": [
    "BidTooLate(uint256,uint256)",
    "BidTooSmall(uint128,uint128)",
    "TopPriceTooHigh(uint256,uint256)",
  ],
};

const ACTIONS: TeamAction[] = [
  "offer-seat",
  "accept-seat",
  "confirm",
  "withdraw",
  "give",
  "hand-over",
  "take-seat",
  "wind-down",
  "spend",
  "launch",
  "link",
  "open-round",
  "open-auction",
  "bid",
  "finish",
  "collect",
  "hand-back",
  "trade",
  "consent",
  "veto",
  "deliver",
];

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

function leaks(sentence: string, name: string) {
  expect(sentence.length).toBeGreaterThan(10);
  expect(sentence).not.toContain(name);
  expect(sentence).not.toMatch(/0x[0-9a-f]/i);
  expect(sentence).not.toMatch(/[a-z][A-Z]/);
}

describe("team copy", () => {
  it("has a plain sentence for every error of every contract, for every action", () => {
    for (const errors of Object.values(ABI_ERRORS))
      for (const signature of errors) {
        const name = signature.slice(0, signature.indexOf("("));
        for (const action of ACTIONS)
          leaks(teamProblem(refused(revertData(signature)), action), name);
      }
  });

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

  it("lists exactly the errors the build's ABIs have", () => {
    const out = resolve(__dirname, "../../../../contracts/next/out");
    if (!existsSync(out)) return;
    for (const [file, errors] of Object.entries(ABI_ERRORS)) {
      const abi = JSON.parse(readFileSync(resolve(out, file), "utf8")).abi as {
        type: string;
        name: string;
        inputs: { type: string }[];
      }[];
      const fromBuild = abi
        .filter((e) => e.type === "error")
        .map((e) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`)
        .sort();
      expect(fromBuild).toEqual([...errors].sort());
    }
  });
});
