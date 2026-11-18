// Who may press, and whose name a receipt carries (F5 and F9 in PLANV2-M6-REPORT.md's "Review fixes"), held through
// the screens themselves rather than the helpers behind them.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  installWallet,
  NOW,
  numbersOf,
  projectEvent,
  record,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  chainIdentity,
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { OpenBacking } from "./OpenBacking";
import { Receipts } from "./Receipts";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
}));

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
  installWallet();
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("F5: only the wallet that runs the project gets Open backing", () => {
  const numbers = () =>
    numbersOf(numbersContent({ coordinate: COORDINATE, now: NOW }));

  it("tells a wallet other than the runner which wallet can, and offers no press", () => {
    wrap(<OpenBacking address={BACKER_EVM} numbers={numbers()} />);
    expect(screen.getByTestId("open-backing-runner").textContent).toMatch(
      /does not run this project/,
    );
    expect(screen.queryByTestId("open-backing-press")).toBeNull();
  });

  it("gives the runner's wallet the press", () => {
    wrap(<OpenBacking address={FOUNDER_EVM} numbers={numbers()} />);
    expect(screen.getByTestId("open-backing-press")).not.toBeNull();
    expect(screen.queryByTestId("open-backing-runner")).toBeNull();
  });
});

describe("F9: a copy naming the same launch never takes a receipt's project name", () => {
  it.each([
    ["first", NOW - 60],
    ["after it", NOW - 2 * 86_400],
  ])("keeps the real project's name when the copy is listed %s", async (_, copyAt) => {
    const { key } = chainIdentity(COORDINATE);
    const [, founder, id] = COORDINATE.split(":");
    serve([
      record(numbersContent({ coordinate: COORDINATE, now: NOW })),
      // The real record, and a copy by someone else naming the same launch (newest first: a newer copy leads).
      projectEvent({ author: founder, id, name: "Lantern", chainKey: key }),
      projectEvent({
        author: "c".repeat(64),
        id,
        name: "Not Lantern",
        chainKey: key,
        at: copyAt,
      }),
    ]);
    wrap(<Receipts />);
    const card = await screen.findByTestId("receipt-project");
    await waitFor(() =>
      expect(card.querySelector("h3")?.textContent).toBe("Lantern"),
    );
  });
});
