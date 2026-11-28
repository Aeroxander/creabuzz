// The launch press: what the sheet says is what the wallet is asked to sign, and the press is shut while the wallet is asked.
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
  holderPauseImpl: ["0x0000000000000000000000000000000000000000"],
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
  it("signs the numbers the sheet shows, and the press is shut while the wallet is asked", async () => {
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
    await screen.findByTestId("launch-terms");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    const before = screen.getByTestId("launch-terms").textContent;
    release();
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(LAUNCHER_ABI, chain.sent[0]?.data ?? "");
    const terms = (call?.args[3] ?? []) as bigint[];
    expect(before).toMatch(/0\.10%/);
    expect(Number(terms[0])).toBe(1000);
  });
});
