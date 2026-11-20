// The gate in front of every money screen: a wallet on another network is told so, and once the person has switched it the
// screens go on (the page asks the wallet which network it is on again). A wallet that shares no account is offered to connect.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
} from "../../../tests/helpers/pot-harness";
import { PageMoney } from "../../../tests/helpers/page-money";

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

function show() {
  return wrap(
    <PageMoney
      chainKey={numbers.key}
      error={null}
      loading={false}
      now={numbers.builtAt + 100}
      numbers={numbers}
      onRetry={() => undefined}
      profiles={undefined}
      projectName="Lantern"
      team={[]}
    />,
  );
}

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

describe("the wallet gate", () => {
  it("a wallet on another network is told so, and after the switch the screens go on without a reload", async () => {
    const chain = installPotChain({
      account: BACKER_EVM,
      chain: "0x1",
      answers: backerAnswers(numbers, { shares: 0n }),
    });
    show();
    const [first] = await screen.findAllByTestId("pot-wrong-network");
    expect(first?.textContent).toMatch(/Your wallet is on another network/);
    expect(screen.queryByTestId("backing-amount")).toBeNull();
    fireEvent.click(
      (first as HTMLElement).querySelector("button") as HTMLButtonElement,
    );
    // The wallet is now on the project's network, and the Back box is there.
    expect(await screen.findByTestId("backing-amount")).not.toBeNull();
    expect(chain.chain).toBe("0x7a69");
    expect(screen.queryByTestId("pot-wrong-network")).toBeNull();
  });
});
