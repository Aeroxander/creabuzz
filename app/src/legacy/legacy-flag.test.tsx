// The ONE flag: off by default, and with it off none of the old design's routes or entry points render. The page tests
// (`ProjectPage.test.tsx` with the flag off, `legacy-project.test.tsx` with it on) hold the project page; this holds the
// flag itself, the route table and Home.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  installWallet,
  SERVER,
  serve,
  wrap,
} from "../../tests/helpers/money-harness";
import { createAppRouter } from "../app/router";
import { HomePage } from "../features/home/HomePage";
import { legacyScreensOn } from "../lib/legacy";

vi.mock(
  "../lib/relay",
  async () => (await import("../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
  useNavigate: () => () => undefined,
  useRouter: () => ({ history: { back: () => undefined }, navigate: vi.fn() }),
  useRouterState: () => ({ location: { pathname: "/", search: "" } }),
}));

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet();
  serve([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
  applyServerSettings(null);
});

describe("the legacy-screens flag", () => {
  it("is off unless the build says exactly 1", () => {
    expect(legacyScreensOn({})).toBe(false);
    for (const value of ["0", "true", "yes", "", "on", undefined, 1])
      expect(legacyScreensOn({ VITE_CREATON_LEGACY_SCREENS: value })).toBe(
        false,
      );
    expect(legacyScreensOn({ VITE_CREATON_LEGACY_SCREENS: "1" })).toBe(true);
    // The real environment of a test run has it off.
    expect(legacyScreensOn()).toBe(false);
  });

  it("with it off the earlier backers' address is not a route; with it on it is", () => {
    expect(
      createAppRouter(false).routesByPath["/earlier" as never],
    ).toBeUndefined();
    expect(
      createAppRouter(true).routesByPath["/earlier" as never],
    ).toBeDefined();
    // The live routes are there either way.
    for (const path of ["/", "/week", "/you", "/start"])
      expect(
        createAppRouter(false).routesByPath[path as never],
        path,
      ).toBeDefined();
  });

  it("Home shows no open rounds with it off, and its own section with it on", async () => {
    wrap(<HomePage />);
    await screen.findByTestId("home-projects");
    expect(screen.queryByTestId("home-rounds")).toBeNull();
    cleanup();
    vi.stubEnv("VITE_CREATON_LEGACY_SCREENS", "1");
    wrap(<HomePage />);
    await waitFor(() =>
      expect(screen.getByTestId("home-rounds")).not.toBeNull(),
    );
    expect(COORDINATE).toBeTruthy();
  });
});
