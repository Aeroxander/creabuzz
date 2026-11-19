// The launch press: what the sheet says is what the wallet is asked to sign (the boxes cannot be edited while the press
// runs), and a launch sent earlier that is still waiting is named as one made with other numbers when the numbers changed.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { parseProject, type Project } from "../project/project-record";
import { LaunchCard } from "./LaunchCard";

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
const HASH = `0x${"ab".repeat(32)}`;
const OTHER = "0x00000000000000000000000000000000000000b2";
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

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  published.length = 0;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  applyServerSettings(null);
});

const answers = {
  settingsHash: [HASH],
  platform: [numbers.contracts.dollar, OTHER, 200n, 1680n, 25_000_000n],
  MAX_RATE_PPM: [2000n],
  MAX_TEAM_POOL: [100_000_000n * S],
  AGENT_SHARE_DIV: [1000n],
  treasuryImpl: [numbers.contracts.treasury],
  vesterImpl: [numbers.contracts.vester],
  MIN_JOIN: [1_000_000n],
  CHECK_IN_MULT: [2n],
  WIND_MULT: [26n],
  CLIFF_MULT: [13n],
  VEST_MULT: [104n],
  projectByKey: () => {
    throw { code: -32603, message: "execution reverted: UnknownProject()" };
  },
};

describe("the launch press", () => {
  it("signs the numbers the sheet shows: the boxes cannot be edited while the wallet is asked", async () => {
    const chain = installPotChain({
      account: FOUNDER_EVM,
      launcher: numbers.launcher,
      answers: answers as never,
    });
    // The wallet holds the signature prompt open until the test lets it go (a person reading it).
    const eth = (
      window as unknown as {
        ethereum: { request: (a: unknown) => Promise<unknown> };
      }
    ).ethereum;
    const real = eth.request.bind(eth);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    eth.request = async (a: unknown) => {
      if ((a as { method: string }).method === "eth_sendTransaction")
        await gate;
      return real(a);
    };
    wrap(<LaunchCard project={project} />);
    fireEvent.click(await screen.findByTestId("launch-open"));
    await screen.findByTestId("launch-rate");
    // The helper's two limits are on the sheet, the Team Shares one beside the dollars one.
    expect(screen.getByTestId("launch-limits").textContent).toMatch(
      /A helper can draw at most 25 dollars a day, and use at most one part in 1,000 of the Team pool in Team Shares a day\./,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    // Both boxes are shut while the press runs; a change that is tried anyway does not reach the sentence.
    const rate = screen.getByTestId("launch-rate") as HTMLInputElement;
    const pool = screen.getByTestId("launch-pool") as HTMLInputElement;
    expect(rate.matches(":disabled")).toBe(true);
    expect(pool.matches(":disabled")).toBe(true);
    const before = screen.getByTestId("launch-terms").textContent;
    release();
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(LAUNCHER_ABI, chain.sent[0]?.data ?? "");
    const terms = (call?.args[3] ?? []) as bigint[];
    expect(before).toMatch(/0\.10%/);
    expect(Number(terms[0])).toBe(1000);
  });

  it("names a launch still waiting from other numbers, and says so when it lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const chain = installPotChain({
        account: FOUNDER_EVM,
        launcher: numbers.launcher,
        answers: answers as never,
      });
      chain.holdReceipts = true;
      wrap(<LaunchCard project={project} />);
      fireEvent.click(await screen.findByTestId("launch-open"));
      await screen.findByTestId("launch-rate");
      fireEvent.click(screen.getByTestId("sheet-confirm")); // 0.10 a day, 10,000,000 Team Shares
      await waitFor(() => expect(chain.sent.length).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200_000);
      });
      await screen.findByTestId("sheet-problem");
      // The founder now wants other numbers (the Team pool can never be changed after a launch).
      fireEvent.change(screen.getByTestId("launch-rate"), {
        target: { value: "0.20" },
      });
      fireEvent.change(screen.getByTestId("launch-pool"), {
        target: { value: "50,000,000" },
      });
      expect(screen.queryByTestId("sheet-earlier-waiting")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
