// The project page shows a strip above its tabs for each task that is planned or running, before anything else about money
// and whichever tab is open; "and n more" goes to the Money tab.
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
  taskRow,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
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

async function page(edit?: Parameters<typeof withTasks>[0], queue = true) {
  serve([
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    }),
    recordV2(
      numbersV2Content({
        coordinate: COORDINATE,
        now: NOW,
        patch: queue ? withTasks(edit) : undefined,
      }),
      COORDINATE,
      NOW,
    ),
  ]);
  wrap(<ProjectPage projectRef={projectRef({ id: ID, author: FOUNDER })} />);
  await screen.findByTestId("project-name");
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("the strips on the project page", () => {
  it("are above the tabs, on the page the person lands on, one for each planned or running task", async () => {
    await page();
    const strips = await screen.findAllByTestId("planned-strip");
    expect(strips.length).toBeGreaterThan(0);
    const tabs = screen.getByRole("tablist");
    for (const strip of strips)
      expect(
        strip.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
  });

  it("are not drawn when the record has no queue", async () => {
    await page(undefined, false);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId("planned-strips")).toBeNull();
  });

  it('show at most three, and "and n more" opens the Money tab', async () => {
    await page((tasks) => {
      const list = tasks.list as Record<string, unknown>[];
      const template = taskRow(tasks, 7);
      let next = Number(tasks.nextSerial);
      for (let i = 0; i < 2; i += 1) {
        list.unshift({
          ...structuredClone(template),
          serial: next,
          what: `0x${(0x70 + i).toString(16).repeat(32)}`,
          repeatOf: null,
        });
        next += 1;
      }
      tasks.nextSerial = next;
      tasks.openCount = (tasks.openCount as number) + 2;
    });
    expect(await screen.findAllByTestId("planned-strip")).toHaveLength(3);
    fireEvent.click(
      await screen.findByRole("button", { name: /^and \d+ more$/ }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Money" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });
});
