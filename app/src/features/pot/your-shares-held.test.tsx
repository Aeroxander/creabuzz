// "You have held it for N weeks" under Your Shares (plan section 7.5): worked out on this device from the account's own
// transfers, drawn only when the read could be finished, never "0 weeks", and with no reward words.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
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
import { targetOf } from "./target";
import { YourShares } from "./YourShares";

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
const target = targetOf(numbers);
/** The standard ERC-20 `Transfer(address,address,uint256)` topic: typed here on purpose, apart from the app's own ABI. */
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const WEEK = 604_800;

function setup(
  shares: bigint,
  logs: unknown[],
  times?: (tag: string) => number,
) {
  installPotChain({
    account: BACKER_EVM,
    answers: {
      ...backerAnswers(numbers, { shares }),
      unit: [BigInt(WEEK)],
    } as never,
    logs,
  });
  if (times) {
    const eth = (
      window as unknown as {
        ethereum: {
          request: (a: {
            method: string;
            params?: unknown[];
          }) => Promise<unknown>;
        };
      }
    ).ethereum;
    const inner = eth.request.bind(eth);
    eth.request = async (args: { method: string; params?: unknown[] }) =>
      args.method === "eth_getBlockByNumber"
        ? { timestamp: `0x${times(String(args.params?.[0])).toString(16)}` }
        : inner(args);
  }
}
const receipt = (block: number, value: bigint) => ({
  address: target.shares,
  topics: [TRANSFER, word(`0x${"c".repeat(40)}`), word(BACKER_EVM)],
  data: word(value.toString(16)),
  blockNumber: `0x${block.toString(16)}`,
});
const show = () => wrap(<YourShares projectName="Lantern" target={target} />);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

describe("how long you have held it", () => {
  it("says the weeks since the holding began, from the chain's own clock", async () => {
    // Block 0x10 is 3 weeks and a bit before the newest block's time.
    const now = 1_800_000_000;
    setup(5n * S, [receipt(0x10, 5n * S)], (tag) =>
      tag === "latest" ? now : now - 3 * WEEK - 100,
    );
    show();
    await waitFor(() =>
      expect(screen.getByTestId("holding-held-since").textContent).toBe(
        "You have held it for 3 weeks.",
      ),
    );
  });

  it("says the day it began when it is under one unit, and never 0 weeks", async () => {
    setup(5n * S, [receipt(0x10, 5n * S)]);
    show();
    await waitFor(() =>
      expect(screen.getByTestId("holding-held-since").textContent).toMatch(
        /^You backed .+\.$/,
      ),
    );
    expect(screen.getByTestId("holding-held-since").textContent).not.toMatch(
      /0 weeks/,
    );
  });

  it("draws nothing when the transfers do not add up to what is held, and nothing for no Shares", async () => {
    setup(9n * S, [receipt(0x10, 5n * S)]);
    show();
    await screen.findByTestId("holding-take-out");
    // The read is done once the line would have come; it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("holding-held-since")).toBeNull();
    cleanup();
    setup(0n, []);
    show();
    await screen.findByTestId("holding-none");
    expect(screen.queryByTestId("holding-held-since")).toBeNull();
  });

  it("has no reward words", async () => {
    setup(5n * S, [receipt(0x10, 5n * S)]);
    show();
    const line = await screen.findByTestId("holding-held-since");
    expect(line.textContent).not.toMatch(
      /point|badge|keep it going|earn|reward|streak/i,
    );
  });
});
