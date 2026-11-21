// Launching from a passkey account: the same sheet, one operation with one launch call, and no step the passkey sender would
// refuse (the build's own Launcher is a contract it may send to). The account that sends is the account the project is stored
// under, so the key the page is tied to is the passkey account's.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { published, SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { createPasskeySender } from "../money/passkey-sender";
import { forgetSendTargets } from "../money/send-targets";
import { injectedWallet } from "../money/wallet";
import { parseProject, type Project } from "../project/project-record";
import { LaunchCard } from "./LaunchCard";

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
const project = parseProject({
  id: "1".repeat(64),
  pubkey: "b".repeat(64),
  kind: 37001,
  created_at: 1_800_000_000,
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
  ],
  content: "{}",
}) as Project;
const operations: { to: string; data: string }[][] = [];

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  forgetSendTargets();
  operations.length = 0;
  published.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("a passkey account launches a project", () => {
  it("sends one launch call as one operation, and ties the page to the passkey account's launch", async () => {
    const chain = installPotChain({
      account: FOUNDER_EVM,
      launcher: numbers.launcher,
      answers: {
        settingsHash: [`0x${"ab".repeat(32)}`],
        platform: [
          numbers.contracts.dollar,
          FOUNDER_EVM,
          200n,
          1680n,
          25_000_000n,
        ],
        MAX_RATE_PPM: [2000n],
        MAX_TEAM_POOL: [100_000_000n * S],
        AGENT_SHARE_DIV: [1000n],
        treasuryImpl: [numbers.contracts.treasury],
        holderPauseImpl: ["0x0000000000000000000000000000000000000000"],
        vesterImpl: [numbers.contracts.vester],
        MIN_JOIN: [1_000_000n],
        CHECK_IN_MULT: [2n],
        WIND_MULT: [26n],
        CLIFF_MULT: [13n],
        VEST_MULT: [104n],
        projectByKey: () => {
          throw {
            code: -32603,
            message: "execution reverted: UnknownProject()",
          };
        },
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
          connectedAddress: async () => FOUNDER_EVM,
          getAddress: async () => FOUNDER_EVM,
          readCall: (to, data) => inner.readCall(to, data),
          blockNumber: () => inner.blockNumber(),
          chainId: () => inner.chainId(),
          getLogs: (f) => inner.getLogs(f),
          outcomeOf: (s) => inner.outcomeOf(s),
          sendCalls: async (calls) => {
            operations.push(calls.map((c) => ({ to: c.to, data: c.data })));
            return {
              hash: `0x${"ab".repeat(32)}`,
              status: "confirmed",
            } as never;
          },
        }),
      },
    );
    wrap(<LaunchCard project={project} />);
    fireEvent.click(await screen.findByTestId("launch-open"));
    await screen.findByTestId("launch-rate");
    // The sheet says the passkey is asked once.
    expect(screen.getByTestId("launch-sheet").textContent).toMatch(/passkey/i);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(operations.length).toBe(1));
    expect(operations[0]).toHaveLength(1);
    const sent = operations[0]?.[0];
    expect(sent?.to).toBe(numbers.launcher);
    expect(decodeCall(LAUNCHER_ABI, sent?.data ?? "")?.args[3]).toEqual([
      1000n,
      10_000_000n * S,
    ]);
    expect(screen.queryByTestId("sheet-problem")).toBeNull();
    // It landed (the passkey sender said so): the page is tied to it.
    chain.answers.projectByKey = [
      [
        FOUNDER_EVM,
        numbers.contracts.shares,
        numbers.contracts.team,
        numbers.contracts.treasury,
        numbers.contracts.vester,
        1_800_000_000n,
      ],
    ] as never;
    await waitFor(() => expect(published.length).toBe(1));
  });
});
