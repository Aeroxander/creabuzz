// The project page on record version 2, with the legacy-screens flag OFF (the default): the page reads the new record, shows
// the project's money with its age and the play-money line, and nothing of the old design (stages, rounds, the auction,
// the market, Team's Pair, the earlier backers) is anywhere on it.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  installWallet,
  NOW,
  projectEvent,
  recordV2,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  chainIdentityV2,
  FOUNDER_EVM,
  numbersV2Content,
} from "../../../tests/helpers/numbers-v2-fixture";
import { LEGACY_TEST_IDS } from "../../../tests/helpers/legacy-test-ids";
import { ProjectPage } from "./ProjectPage";
import { projectRef } from "./project-record";

const [, FOUNDER, ID] = COORDINATE.split(":");

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
  useNavigate: () => () => undefined,
  useRouter: () => ({ history: { back: () => undefined }, navigate: vi.fn() }),
  useRouterState: () => ({ location: { pathname: "/p", search: "" } }),
}));

async function page(
  patch?: (content: Record<string, unknown>) => void,
  recordAt = NOW,
) {
  serve([
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    }),
    recordV2(
      numbersV2Content({ coordinate: COORDINATE, now: recordAt, patch }),
      COORDINATE,
      recordAt,
    ),
  ]);
  wrap(<ProjectPage projectRef={projectRef({ id: ID, author: FOUNDER })} />);
  await screen.findByTestId("project-name");
  // Radix opens a tab on the press, not the click.
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Money" }), {
    button: 0,
  });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("the project page on record version 2", () => {
  it("shows the project's money, the play-money line and the legal line", async () => {
    await page();
    const pot = await screen.findByTestId("money-pot");
    expect(pot.textContent).toBe("7,322.81");
    expect(screen.getByTestId("play-money").textContent).toMatch(
      /play money, not real money/,
    );
    expect(screen.getByTestId("ownership").textContent).toBe(
      "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.",
    );
    expect(
      screen.getByText(/This can go up or down. It is not a return./),
    ).not.toBeNull();
    expect(screen.queryByTestId("money-as-of")).toBeNull();
  });

  it("says 'Numbers as of' when the record is older than three refresh periods", async () => {
    // The server signed it four hours before this page opened: past 3 x 600 + 60 seconds, within a day.
    await page(undefined, NOW - 4 * 3600);
    await waitFor(() =>
      expect(screen.getByTestId("money-as-of")).not.toBeNull(),
    );
    expect(screen.getByTestId("money-as-of").textContent).toMatch(
      /^Numbers as of /,
    );
    expect(screen.queryByTestId("money-stale")).toBeNull();
  });

  it("says the numbers could not be refreshed after a day, and that taking money out still works", async () => {
    await page(undefined, NOW - 2 * 86_400);
    const stale = await screen.findByTestId("money-stale");
    expect(stale.textContent).toMatch(
      /not been able to refresh this project's numbers since/,
    );
    expect(stale.textContent).toMatch(/you can take it out any time/);
    expect(screen.queryByTestId("money-pot")).toBeNull();
  });

  it("carries nothing of the old design: no stage line, no round, no auction, no market, no Pair, no earlier backers", async () => {
    await page();
    await screen.findByTestId("money-pot");
    await new Promise((r) => setTimeout(r, 50));
    for (const id of LEGACY_TEST_IDS)
      expect(screen.queryByTestId(id), id).toBeNull();
  });
});
