// The runner's presses from a passkey account, through the real sheets: draw from the box and grant Team Shares each send
// exactly the one call the sheet showed, as one operation (one passkey prompt, no wallet), and what the sheet says before,
// during and after names the passkey and the account, never a wallet. The same sheets with a wallet say what they always did.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  D,
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { createPasskeySender } from "../money/passkey-sender";
import { forgetSendTargets, rememberSendTargets } from "../money/send-targets";
import { injectedWallet } from "../money/wallet";
import { AllowanceSection } from "./AllowanceSection";
import { TeamSharesSection } from "./TeamSharesSection";

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
const NOW = numbers.builtAt + 100;
const TO = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const operations: { to: string; data: string }[][] = [];

const answers = {
  box: [700n * D],
  boxCap: [7_000n * D],
  ratePpm: [1_000n],
  pendingRatePpm: [0n],
  pendingAt: [0n],
  lastCheckIn: [BigInt(NOW - 3 * 86_400)],
  activeEnd: [BigInt(NOW + 11 * 86_400)],
  MAX_RATE_PPM: [2_000n],
  unit: [BigInt(numbers.unit)],
  idsOf: [[]],
};

/** The passkey sender the app builds, over the page's chain for reads, recording each operation it is asked to send. */
function passkeyFor(shown: { account: string }) {
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
          operations.push(calls.map((c) => ({ to: c.to, data: c.data })));
          return {
            txHash: `0x${"ab".repeat(32)}`,
            status: "confirmed",
          } as never;
        },
      }),
    },
  );
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  forgetSendTargets();
  rememberSendTargets(Object.values(numbers.contracts));
  operations.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the runner's sheets, from a passkey account", () => {
  it("draws from the box: one operation with the one call shown, and the sheet says passkey, not wallet", async () => {
    installPotChain({ account: FOUNDER_EVM, answers: answers as never });
    passkeyFor({ account: FOUNDER_EVM });
    wrap(
      <AllowanceSection address={FOUNDER_EVM} now={NOW} numbers={numbers} />,
    );
    fireEvent.click(await screen.findByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "3" },
    });
    const sheet = screen.getByTestId("sheet-confirm").closest("[role=dialog]");
    expect(sheet?.textContent ?? "").not.toMatch(/wallet/i);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(operations.length).toBe(1));
    expect(operations[0]).toHaveLength(1);
    expect(operations[0]?.[0]?.to).toBe(numbers.contracts.treasury);
    const decoded = decodeCall(TREASURY_ABI, operations[0]?.[0]?.data ?? "0x");
    expect(decoded?.name).toBe("draw");
    expect(decoded?.args).toEqual([TO, 3_000_000n]);
    expect(
      await screen.findByText(/Sent\.|dollars? (is|are) on the way|Drawn/i),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/your wallet/i);
  });

  it("grants Team Shares: one operation with the one call shown", async () => {
    installPotChain({ account: FOUNDER_EVM, answers: answers as never });
    passkeyFor({ account: FOUNDER_EVM });
    wrap(
      <TeamSharesSection
        address={FOUNDER_EVM}
        members={[
          { pubkey: "a".repeat(64), name: "Anna", address: BACKER_EVM },
        ]}
        numbers={numbers}
      />,
    );
    fireEvent.click(await screen.findByTestId("grant-open"));
    await screen.findByTestId("grant-pool");
    fireEvent.change(screen.getByLabelText("Grant to"), {
      target: { value: "a".repeat(64) },
    });
    fireEvent.change(screen.getByLabelText("How many Team Shares?"), {
      target: { value: "1,500" },
    });
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(operations.length).toBe(1));
    const decoded = decodeCall(TREASURY_ABI, operations[0]?.[0]?.data ?? "0x");
    expect(decoded?.name).toBe("grantTeam");
    expect(decoded?.args).toEqual([BACKER_EVM, 1_500n * S]);
    expect(document.body.textContent).not.toMatch(/your wallet/i);
  });

  it("is refused in words when the account behind the passkey changed since the numbers were read, and sends nothing", async () => {
    installPotChain({ account: FOUNDER_EVM, answers: answers as never });
    const shown = { account: FOUNDER_EVM };
    passkeyFor(shown);
    wrap(
      <AllowanceSection address={FOUNDER_EVM} now={NOW} numbers={numbers} />,
    );
    fireEvent.click(await screen.findByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "3" },
    });
    // The sender now shows another account (a different passkey was set up in this browser meanwhile).
    shown.account = BACKER_EVM;
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /account behind your passkey is not the one these numbers were read for/,
    );
    expect(operations.length).toBe(0);
  });
});
