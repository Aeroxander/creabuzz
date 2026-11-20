// A part of the page whose code fails to load (after a deploy, on a bad phone network) must not take the whole page, and with it
// Take out, away: that part says so, with a press to reload, and the tabs stay.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
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
import { ProjectPage } from "./ProjectPage";
import { projectRef } from "./project-record";

const [, FOUNDER, ID] = COORDINATE.split(":");
vi.mock("./BackSection", () => {
  throw new Error("Failed to fetch dynamically imported module");
});
vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: null, locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
  useNavigate: () => () => undefined,
  useRouter: () => ({ history: { back: () => undefined }, navigate: vi.fn() }),
  useRouterState: () => ({ location: { pathname: "/p", search: "" } }),
}));
beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("a lazy part of the page fails to load", () => {
  it("the Money tab (where Take out is) is still reachable, and the failed part says so", async () => {
    serve([
      projectEvent({
        author: FOUNDER,
        id: ID,
        name: "Lantern",
        chainKey: chainIdentityV2(COORDINATE).key,
      }),
      recordV2(
        numbersV2Content({ coordinate: COORDINATE, now: NOW }),
        COORDINATE,
        NOW,
      ),
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    wrap(<ProjectPage projectRef={projectRef({ id: ID, author: FOUNDER })} />);
    await new Promise((r) => setTimeout(r, 800));
    spy.mockRestore();
    expect(screen.queryByRole("tab", { name: "Money" })).not.toBeNull();
    expect((await screen.findByTestId("chunk-failed")).textContent).toMatch(
      /could not load/,
    );
  });
});
