// Opening a project's page reads its news: the strips are that news, so the alerts of the project are marked read on this
// device, and a person the record lists as a holder is remembered as holding it (the dot on You then reads that project
// first). A link may open the Money tab.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
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
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import { alertsOf } from "../alerts/alerts";
import { heldKeys, readSeen } from "../alerts/seen";
import { sceneNumbers } from "../../../tests/helpers/plan-scene";
import { ProjectPage } from "./ProjectPage";
import { projectRef } from "./project-record";

const PUBKEY = "b".repeat(64);
const [, FOUNDER, ID] = COORDINATE.split(":");
const numbers = sceneNumbers();

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

function open(initialTab?: "money", queue = true) {
  serve([
    projectEvent({
      author: FOUNDER as string,
      id: ID as string,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    }),
    recordV2(
      numbersV2Content({
        coordinate: COORDINATE,
        now: NOW,
        patch: queue ? withTasks() : undefined,
      }),
      COORDINATE,
      NOW,
    ),
  ]);
  wrap(
    <ProjectPage
      initialTab={initialTab}
      projectRef={projectRef({ id: ID as string, author: FOUNDER as string })}
    />,
  );
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

describe("opening a project's page", () => {
  it("marks the project's news read on this device, and only that project's", async () => {
    const news = alertsOf({
      numbers: [numbers],
      names: new Map(),
      me: [FOUNDER_EVM],
      held: () => true,
      tasksOf: () => undefined,
      now: numbers.asOf.time,
    });
    expect(news.length).toBeGreaterThan(0);
    open();
    await waitFor(() =>
      expect(Object.keys(readSeen(PUBKEY)).sort()).toEqual(
        news.map((a) => a.id).sort(),
      ),
    );
  });

  it("remembers that a person the record lists holds the project", async () => {
    open();
    await waitFor(() =>
      expect(heldKeys(PUBKEY, FOUNDER_EVM)).toEqual([numbers.key]),
    );
  });

  it("marks nothing for a record with no queue", async () => {
    open(undefined, false);
    await screen.findByTestId("project-name");
    await new Promise((r) => setTimeout(r, 150));
    expect(readSeen(PUBKEY)).toEqual({});
  });

  it("opens the Money tab when the link asks for it, and the Updates tab otherwise", async () => {
    open("money");
    await screen.findByTestId("project-name");
    expect(
      screen.getByRole("tab", { name: "Money" }).getAttribute("aria-selected"),
    ).toBe("true");
    cleanup();
    open();
    await screen.findByTestId("project-name");
    expect(
      screen
        .getByRole("tab", { name: "Updates" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
