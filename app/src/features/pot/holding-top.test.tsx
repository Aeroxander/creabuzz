// The top of a project's page: a holder sees what they hold, what it is worth now, the not-a-return sentence and Take out
// first, with Back as the second press; a visitor sees Back as the primary press and no line about Shares.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_A_RETURN_LITERAL } from "../../../tests/helpers/legal-words";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { PageMoney } from "../../../tests/helpers/page-money";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";

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

function show(answers: Record<string, unknown>) {
  const chain = installPotChain({
    account: BACKER_EVM,
    answers: { ...backerAnswers(numbers, { shares: 0n }), ...answers } as never,
  });
  wrap(
    <PageMoney
      chainKey={numbers.key}
      error={undefined}
      loading={false}
      now={numbers.builtAt + 100}
      numbers={numbers}
      onRetry={() => undefined}
      profiles={undefined}
      projectName="Lantern"
      team={[]}
    />,
  );
  return chain;
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

describe("the top of the page", () => {
  it("for a holder says what they hold and what it is worth, with the sentence beside it, and Take out is the primary press", async () => {
    show({
      balanceOf: (_args: readonly unknown[], to: string) =>
        to === numbers.contracts.shares ? [1_020n * S] : [0n],
    });
    const top = await screen.findByTestId("top-holding");
    expect(top.textContent).toBe(
      `You hold 1,020 Shares, worth 9.99 dollars.${NOT_A_RETURN_LITERAL}Take out`,
    );
    expect(screen.getByTestId("holding-take-out").className).toMatch(
      /btn-primary/,
    );
    expect(screen.getByTestId("backing-review").className).toMatch(
      /btn-secondary/,
    );
    // It comes before the Back box.
    expect(
      top.compareDocumentPosition(screen.getByTestId("backing-box")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("for a visitor draws no line about Shares, and Back is the primary press", async () => {
    show({});
    const back = await screen.findByTestId("backing-review");
    await screen.findByTestId("holding-dollars");
    expect(screen.queryByTestId("top-holding")).toBeNull();
    expect(back.className).toMatch(/btn-primary/);
  });

  it("when what is held cannot be read says so with a way to try again, never that nothing is held", async () => {
    let failing = true;
    show({
      balanceOf: (_args: readonly unknown[], to: string) => {
        if (failing && to === numbers.contracts.shares)
          throw new Error("node hiccup");
        return to === numbers.contracts.shares ? [1_020n * S] : [0n];
      },
    });
    const failed = await screen.findByTestId("top-holding-failed");
    expect(failed.textContent).toMatch(/could not be read/);
    expect(screen.queryByTestId("holding-take-out")).toBeNull();
    failing = false;
    fireEvent.click(within(failed).getByText("Try again"));
    await waitFor(() =>
      expect(screen.getByTestId("holding-take-out")).not.toBeNull(),
    );
  });
});
