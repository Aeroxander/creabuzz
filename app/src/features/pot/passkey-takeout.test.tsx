// Take out through the Launcher alone (the server's record cannot be read) works for the passkey account as it does for the
// wallet. The passkey sender sends only to contracts this app has read; the take-out's own read of what the account holds
// makes the project's contracts known to it, so the exit is not refused as "not one of this project's contracts".
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { forgetSendTargets } from "../money/send-targets";
import { createPasskeySender } from "../money/passkey-sender";
import { injectedWallet } from "../money/wallet";
import { ProjectMoney } from "./ProjectMoney";

const holder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../money/sender", async (actual) => ({
  ...(await actual<object>()),
  useSender: () => holder.current,
}));
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
const sentByPasskey: unknown[] = [];

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  forgetSendTargets();
  sentByPasskey.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the passkey account takes out through the Launcher alone", () => {
  const setUp = (shown: { account: string }) => {
    installPotChain({
      account: BACKER_EVM,
      answers: {
        ...backerAnswers(numbers, { shares: 1_000n * S }),
        projectByKey: [
          [
            numbers.founder,
            numbers.contracts.shares,
            numbers.contracts.team,
            numbers.contracts.treasury,
            numbers.contracts.vester,
            1_700_000_000n,
          ],
        ],
      } as never,
    });
    const inner = injectedWallet();
    holder.current = createPasskeySender(
      {
        chainId: numbers.chainId,
        rpcUrl: "http://rpc.invalid",
        bundlerUrl: "http://bundler.invalid",
      },
      {
        probe: {
          credentialId: () => "cred",
          ownerKey: () => `04${"11".repeat(64)}`,
        },
        load: async () => ({
          connectedAddress: async () => shown.account,
          getAddress: async () => shown.account,
          readCall: (to, data) => inner.readCall(to, data),
          blockNumber: () => inner.blockNumber(),
          chainId: () => inner.chainId(),
          getLogs: (f) => inner.getLogs(f),
          outcomeOf: (s) => inner.outcomeOf(s),
          sendCalls: async (calls) => {
            sentByPasskey.push(...calls);
            return {
              hash: `0x${"ab".repeat(32)}`,
              status: "confirmed",
            } as never;
          },
        }),
      },
    );
    wrap(
      <ProjectMoney
        chainKey={numbers.key}
        error={new Error("The server did not answer.")}
        loading={false}
        now={numbers.builtAt + 100}
        numbers={null}
        onRetry={() => undefined}
        profiles={undefined}
        projectName="Lantern"
        team={[]}
      />,
    );
  };

  it("sends the take-out when the server's record cannot be read, and says the money is in the account", async () => {
    setUp({ account: BACKER_EVM });
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(sentByPasskey.length).toBe(1));
    expect(screen.queryByTestId("sheet-problem")).toBeNull();
    // The note that it landed names the account, not a wallet.
    expect(
      await screen.findByText("Taken out. The money is in your account."),
    ).toBeTruthy();
  });

  it("refuses to send when the account behind the passkey is not the one the numbers were read for, in words with no wallet", async () => {
    const shown = { account: BACKER_EVM };
    setUp(shown);
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    shown.account = `0x${"99".repeat(20)}`;
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(
      /The account behind your passkey is not the one these numbers were read for/,
    );
    expect(problem.textContent).not.toMatch(/wallet/i);
    expect(sentByPasskey.length).toBe(0);
  });
});
