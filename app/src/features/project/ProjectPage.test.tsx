// When the Project page offers Open backing (F5 and A8 in PLANV2-M6-REPORT.md's "Review fixes"), held through the page
// itself: the founder's page at Solo or Backed with every round closed, never at Team, never while a round past its 24
// hours waits to be closed.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  DAY,
  installWallet,
  NOW,
  projectEvent,
  record,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  chainIdentity,
  FOUNDER_EVM,
  type NumbersOptions,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
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

/** The founder's own page, with the founder's wallet connected and the numbers `options` gives. */
async function founderPage(options: Partial<NumbersOptions>) {
  serve([
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentity(COORDINATE).key,
    }),
    record(numbersContent({ coordinate: COORDINATE, now: NOW, ...options })),
  ]);
  wrap(<ProjectPage projectRef={projectRef({ id: ID, author: FOUNDER })} />);
  await screen.findByTestId("project-name");
  // The numbers are in once the stage line shows the money raised (Backed reached).
  await waitFor(() =>
    expect(
      screen.getByTestId("stage-backed").getAttribute("data-reached"),
    ).not.toBe("no"),
  );
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("Open backing on the Project page", () => {
  it("is offered to the founder at Backed with every round closed", async () => {
    await founderPage({ stage: "backed" });
    expect(await screen.findByTestId("open-backing")).not.toBeNull();
  });

  it("is not offered at Team (its runner is the Pair, not this wallet)", async () => {
    await founderPage({ stage: "team" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("open-backing")).toBeNull();
  });

  it("is not offered while a round past its 24 hours waits to be closed", async () => {
    await founderPage({ stage: "backed", openRound: { openedAgo: DAY + 600 } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("back-box")).toBeNull();
    expect(screen.queryByTestId("open-backing")).toBeNull();
  });
});
