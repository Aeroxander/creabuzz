// The faucet: one press on the page, while the account has not taken its play dollars, and nothing once it has.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { faucetCall } from "@creaton/core/pot/pot-calls.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
} from "../../../tests/helpers/pot-harness";
import { BackCard } from "./BackCard";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
}));

const numbers = numbersFor();
let chain: PotChain;

function show(answers: Record<string, unknown> = {}) {
  chain = installPotChain({
    account: BACKER_EVM,
    answers: { ...backerAnswers(numbers, { shares: 0n }), ...answers } as never,
  });
  wrap(
    <BackCard
      now={numbers.builtAt + 100}
      numbers={numbers}
      projectName="Lantern"
    />,
  );
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

describe("play dollars", () => {
  it("one press sends the one faucet call, with no sheet in between", async () => {
    show();
    fireEvent.click(await screen.findByTestId("faucet-open"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(numbers.contracts.dollar);
    expect(chain.sent[0].data).toBe(faucetCall(numbers.contracts.dollar).data);
    expect(screen.queryByTestId("faucet-sheet")).toBeNull();
  });

  it("an account that already took them is offered no press", async () => {
    show({ faucetUsed: [true] });
    await screen.findByTestId("backing-review");
    // The read has had its turn once the Back box is drawn; the faucet never shows.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("faucet-open")).toBeNull();
  });

  it("a refused press says what happened and keeps the press", async () => {
    show();
    chain.refuse = "execution reverted";
    fireEvent.click(await screen.findByTestId("faucet-open"));
    expect(await screen.findByTestId("faucet-problem")).not.toBeNull();
    expect(screen.getByTestId("faucet-open")).not.toBeNull();
  });
});
