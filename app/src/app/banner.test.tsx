// The banner "You can take your money out any time. Nothing here promises a profit." is on every page and every sheet
// that shows money, word for word, exactly once: the shell draws it under each page, a page that draws its own takes the
// shell's away, a sheet carries it through `PotSheet`, and a new route or a new kind of sheet has to say where it stands.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWallet, SERVER, wrap } from "../../tests/helpers/money-harness";
import { FOUNDER_EVM } from "../../tests/helpers/numbers-v2-fixture";
import { PotSheet } from "../features/pot/PotSheet";
import { BANNER_LITERAL } from "../../tests/helpers/legal-words";
import { BannerText, useOwnBanner } from "./MoneyBanner";
import { createAppRouter } from "./router";
import { Shell } from "./Shell";

vi.mock(
  "../lib/relay",
  async () => (await import("../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
// The notices the shell hosts are not what is tested here.
vi.mock("../features/account/TermsAgainHost", () => ({
  TermsAgainHost: () => null,
}));
vi.mock("../features/account/UnlockBar", () => ({ UnlockBar: () => null }));
vi.mock("../features/account/RecoveryKeySheet", () => ({
  RecoveryOfferHost: () => null,
}));

const BANNER = "money-banner";
const bannerCount = () => screen.queryAllByTestId(BANNER).length;
const wording = () => screen.queryAllByText(BANNER_LITERAL).length;

/** Every path of the real route tree, with a concrete address that matches it. */
const REAL_PATHS = Object.keys(createAppRouter().routesByPath).sort();
const concrete = (path: string) => path.replace(/\$[A-Za-z]+/g, "x");

/**
 * What each real route does about the banner: the shell draws one (1), or the screen is the sign-up page and draws none (0).
 * A page that draws its own is listed in `OWN` and tested for real where its page is built.
 */
const SHELL_DRAWS: Record<string, 0 | 1> = {
  "/": 1,
  "/p/$ref": 1,
  "/start": 1,
  "/week": 1,
  "/you": 1,
  "/you/saved": 1,
  "/search": 1,
  "/tag/$tag": 1,
  "/post/$id": 1,
  "/u/$pubkey": 1,
  "/welcome": 0,
};

function shellAt(
  path: string,
  page: () => React.ReactNode = () => <main>page</main>,
) {
  const root = createRootRoute({ component: Shell });
  const routes = REAL_PATHS.map((p) =>
    createRoute({ getParentRoute: () => root, path: p, component: page }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [concrete(path)] }),
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("the banner on every route", () => {
  it("every route of the app has a line in this test", () => {
    expect(REAL_PATHS).toEqual(Object.keys(SHELL_DRAWS).sort());
  });

  it.each(
    REAL_PATHS,
  )("%s draws the banner as the shell's settings say, word for word", async (path) => {
    shellAt(path);
    await screen.findByText("page");
    expect(bannerCount()).toBe(SHELL_DRAWS[path]);
    expect(wording()).toBe(SHELL_DRAWS[path]);
  });

  it("draws the owner's sentence word for word (compared with the literal, not with the app's own constant)", async () => {
    shellAt("/");
    await screen.findByText("page");
    expect(screen.getByTestId("shell-banner").textContent).toBe(
      "You can take your money out any time. Nothing here promises a profit.",
    );
  });

  it("is not drawn where the server does not offer investing", async () => {
    applyServerSettings(null);
    shellAt("/");
    await screen.findByText("page");
    expect(bannerCount()).toBe(0);
  });

  it("a page that draws its own is the only one: the shell steps aside, never two", async () => {
    function Own() {
      useOwnBanner();
      return (
        <main>
          page
          <BannerText />
        </main>
      );
    }
    shellAt("/p/$ref", () => <Own />);
    await screen.findByText("page");
    await waitFor(() => expect(bannerCount()).toBe(1));
    expect(screen.queryByTestId("shell-banner")).toBeNull();
  });

  it("a page that says it draws its own and does not is left with none (the claim is the page's word)", async () => {
    function Claims() {
      useOwnBanner(false);
      return <main>page</main>;
    }
    shellAt("/", () => <Claims />);
    await screen.findByText("page");
    expect(screen.getByTestId("shell-banner")).not.toBeNull();
  });
});

describe("the banner on every sheet that shows money", () => {
  it("the one sheet every money press goes through carries the whole banner", () => {
    installWallet({ account: FOUNDER_EVM });
    wrap(
      <PotSheet
        account={FOUNDER_EVM}
        action="banner-test"
        calls={null}
        chainId={31337}
        confirmLabel="Go"
        done="Done"
        lookLabel="Look"
        onOpenChange={() => undefined}
        open
        playMoney
        problemAction="back"
        testId="banner-sheet"
        title="A money sheet"
      >
        <p>numbers</p>
      </PotSheet>,
    );
    expect(screen.getByTestId("sheet-banner").textContent).toBe(BANNER_LITERAL);
  });

  // Every other sheet is named here, with why it needs none: a sheet that is added without a line fails this test.
  const OWN_BANNER = "carries the banner itself";
  const OTHER_SHEETS: Record<string, string> = {
    "features/project/ShareSheet.tsx": OWN_BANNER,
    "features/account/RecoveryKeySheet.tsx": "a secret key, no money",
    "features/account/TermsAgainHost.tsx": "the terms, no money",
    "features/posts/Composer.tsx": "a post, no money",
    "features/room/HiddenSheet.tsx": "the people you hide, no money",
    "features/room/PostMenu.tsx": "a list of presses on a post, no money",
    "features/room/RoomSheets.tsx": "the report form, no money",
    "features/safety/PostMore.tsx":
      "the question before deleting a post, no money",
    "features/tasks/PostTaskSheet.tsx": "the old task board: not mounted",
    "features/tasks/TaskCard.tsx": "the old task board: not mounted",
    "features/week/WeeklySheet.tsx": "the weekly note, no money",
    "features/you/YouPage.tsx": "account and notes, no money figure",
  };
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [full] : [];
    });
  }

  it("every sheet other than the money sheet is named, with its reason", () => {
    const root = join(process.cwd(), "src");
    const users = sources(root)
      .filter((f) => /ui\/sheet"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1))
      .filter((f) => f !== "features/pot/PotSheet.tsx")
      .sort();
    expect(users).toEqual(Object.keys(OTHER_SHEETS).sort());
    // A sheet that says it carries the banner draws the banner's own component.
    for (const [file, why] of Object.entries(OTHER_SHEETS))
      if (why === OWN_BANNER)
        expect(readFileSync(join(root, file), "utf8"), file).toMatch(
          /<BannerText\b/,
        );
  });
});
