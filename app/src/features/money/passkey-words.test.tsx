// A person who signs in with a passkey has no wallet: no screen on the path of a passkey account tells them "your wallet".
// Each test renders the real screen with a passkey sender (and the same screen with a wallet, to show that a wallet
// person's words did not move), and reads what is on it. The passkey account's own states (being read, not read, refused
// by a lying node) are told in words of their own.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { nameTheNetwork, numbersFor } from "../../../tests/helpers/pot-harness";
import { WalletGate } from "../pot/use-pot";
import { ACCOUNT_MISMATCH_WORDS } from "./copy";
import { senderWords } from "./sender";
import { type MoneyWallet, WalletStepError } from "./wallet";

const ACCOUNT = `0x${"11".repeat(20)}`;

function stand(
  kind: "wallet" | "passkey",
  address: () => Promise<string | null>,
): MoneyWallet {
  return {
    kind,
    capabilities: {
      signsMessages: true,
      atomicBatch: kind === "passkey",
      feeSponsored: kind === "passkey",
    },
    isAvailable: () => true,
    connectedAddress: address,
    getAddress: async () => ACCOUNT,
    chainId: async () => 31337,
    readCall: async () => "0x",
  } as unknown as MoneyWallet;
}

let current: MoneyWallet;
vi.mock("./sender", async (original) => ({
  ...(await original<typeof import("./sender")>()),
  useSender: () => current,
}));
vi.mock("../../lib/relay", () => ({
  read: async () => [],
  publish: async () => undefined,
}));
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "a".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
}));

const numbers = numbersFor();
const NEVER = new Promise<string | null>(() => undefined);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

const text = () => document.body.textContent ?? "";

describe("the words of a passkey person", () => {
  it("never name a wallet where the sender is the passkey account", () => {
    const words = senderWords(stand("passkey", async () => ACCOUNT));
    expect(Object.values(words).join(" ")).not.toMatch(/wallet/i);
    expect(words.own).toBe("your account");
    // A wallet person's words are the ones they always had.
    const wallet = senderWords(stand("wallet", async () => ACCOUNT));
    expect(wallet.own).toBe("your wallet");
    expect(wallet.waiting).toBe("Waiting for your wallet…");
  });
});

describe("the gate in front of a money step, for a passkey account", () => {
  const gate = () =>
    wrap(
      <WalletGate chainId={numbers.chainId} what="back this project">
        {() => <p data-testid="ready">ready</p>}
      </WalletGate>,
    );

  it("says the account is being read, not that a wallet must be connected", async () => {
    current = stand("passkey", () => NEVER);
    gate();
    expect((await screen.findByTestId("pot-connect")).textContent).toMatch(
      /Reading your account to back this project/,
    );
    expect(text()).not.toMatch(/wallet/i);
  });

  it("says the account could not be read, with one press to try again", async () => {
    current = stand("passkey", async () => null);
    gate();
    expect(
      await screen.findByText(/Your account could not be read just now/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(text()).not.toMatch(/wallet/i);
  });

  it("shows no account and says why when the server's address for it is wrong", async () => {
    current = stand("passkey", async () => {
      throw new WalletStepError("account-mismatch", 0);
    });
    gate();
    expect(
      (await screen.findByTestId("pot-account-mismatch")).textContent,
    ).toBe(ACCOUNT_MISMATCH_WORDS);
    expect(screen.queryByTestId("ready")).toBeNull();
    expect(screen.queryByTestId("pot-connect")).toBeNull();
  });

  it("goes on when the account is read; a wallet that shares none is still asked to connect", async () => {
    current = stand("passkey", async () => ACCOUNT);
    gate();
    await screen.findByTestId("ready");
    cleanup();
    current = stand("wallet", async () => null);
    gate();
    expect((await screen.findByTestId("pot-connect")).textContent).toMatch(
      /Connect your wallet to back this project/,
    );
  });
});
