// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
// The top of a project's page (plan section 7.1) on record version 2: the project's money with
// its line, the play-money line, the fixed banner once, one Back box, Share, the facts,
// and what is drawn when the record is old, from an older server, or has a key it could not work out. Every figure is read
// from the example the server's own code wrote.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import {
  chainIdentityV2,
  FOUNDER_EVM,
  numbersV2Content,
  withSocial,
} from "../../../tests/helpers/numbers-v2-fixture";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { WithMoneyBanner } from "../../app/MoneyBanner";
import { smallDollarsText } from "../money/copy";
import { PLAY_MONEY_WORDS } from "../money/copy";
import { BANNER_LITERAL } from "../../../tests/helpers/legal-words";
import { ProjectPage } from "./ProjectPage";
import { projectPath, projectRef } from "./project-record";
import { takeOutNowLine } from "./project-top-words";

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

type Json = Record<string, unknown>;

async function page(
  patch?: (content: Json) => void,
  recordAt = NOW,
  options: { shell?: boolean } = {},
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
  const view = (
    <ProjectPage projectRef={projectRef({ id: ID, author: FOUNDER })} />
  );
  wrap(options.shell ? <WithMoneyBanner>{view}</WithMoneyBanner> : view);
  await screen.findByTestId("project-name");
}
const top = () => screen.getByTestId("project-top");

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllGlobals();
});

describe("the money, the banner and Back in the order a stranger reads them", () => {
  it("the name, the money with its line, the play-money line, the banner, then Back and Share", async () => {
    await page();
    const n = parsedExample();
    const money = await screen.findByTestId("top-money");
    expect(screen.getByTestId("top-money-pot").textContent).toBe(
      smallDollarsText(n.money.pot),
    );
    expect(money.textContent).toContain(
      "This can go up or down. It is not a return.",
    );
    expect(screen.getByTestId("top-take-out-now").textContent).toBe(
      takeOutNowLine(n),
    );
    expect(screen.getByTestId("top-play-money").textContent).toBe(
      PLAY_MONEY_WORDS,
    );
    expect(screen.getByTestId("money-banner").textContent).toBe(BANNER_LITERAL);
    const back = await screen.findByTestId("backing-box");
    const order = [
      screen.getByTestId("project-name"),
      money,
      screen.getByTestId("top-banner"),
      back,
      screen.getByTestId("share-open"),
    ];
    for (let i = 1; i < order.length; i += 1)
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${i}`,
      ).toBeTruthy();
  });

  it("the page draws the banner once and the shell steps aside; there is one Back box, with the Money tab open too", async () => {
    await page(undefined, NOW, { shell: true });
    await screen.findByTestId("backing-box");
    expect(screen.getAllByTestId("money-banner")).toHaveLength(1);
    expect(screen.queryByTestId("shell-banner")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Money" }), {
      button: 0,
    });
    await screen.findByTestId("project-money");
    expect(
      screen.getAllByRole("region", { name: "Back this project" }),
    ).toHaveLength(1);
    expect(screen.getAllByTestId("backing-box")).toHaveLength(1);
  });
});

describe("what is drawn when a key is absent, null, wrong or old", () => {
  it("a record without the social keys still shows the money, and Back", async () => {
    await page(
      withSocial({
        held: "absent",
        feed: "absent",
        streaks: "absent",
      }),
    );
    expect(await screen.findByTestId("top-money-pot")).not.toBeNull();
    expect(screen.getByTestId("backing-box")).not.toBeNull();
  });

  it("a key that is wrong reads as null for that part, and the money page stands", async () => {
    await page((c) => {
      (c.held as Record<string, unknown>).rank = "garbage";
    });
    expect(await screen.findByTestId("top-money-pot")).not.toBeNull();
    expect(screen.getByTestId("backing-box")).not.toBeNull();
  });

  it("a record older than three refresh periods says 'Numbers as of'", async () => {
    await page(undefined, NOW - 4 * 3600);
    expect((await screen.findByTestId("top-as-of")).textContent).toMatch(
      /^Numbers as of /,
    );
    expect(screen.getByTestId("top-money-pot")).not.toBeNull();
  });

  it("a record older than a day shows none of the money, and Back waits", async () => {
    await page(undefined, NOW - 2 * 86_400);
    expect(await screen.findByTestId("top-money-stale")).not.toBeNull();
    expect(screen.queryByTestId("top-money-pot")).toBeNull();
    expect(screen.queryByTestId("top-take-out-now")).toBeNull();
    expect(screen.getByTestId("back-paused").textContent).toMatch(
      /Taking your money out does not wait/,
    );
    // The banner is still on the page, once.
    expect(screen.getAllByTestId("money-banner")).toHaveLength(1);
  });

  it("with investing off nothing of this is drawn: the name, the line and who started it", async () => {
    applyServerSettings(null);
    await page();
    expect(screen.queryByTestId("top-money")).toBeNull();
    expect(screen.queryByTestId("backing-box")).toBeNull();
    expect(screen.queryByTestId("money-banner")).toBeNull();
    expect(screen.queryByTestId("share-open")).toBeNull();
    expect(top().textContent).toMatch(/Started by/);
  });
});

describe("assistive semantics", () => {
  it("has no serious violation with the page, and with the Share sheet open", async () => {
    await page();
    await screen.findByTestId("backing-box");
    expect(await seriousViolations()).toEqual([]);
    fireEvent.click(screen.getByTestId("share-open"));
    await screen.findByTestId("share-sheet");
    expect(await seriousViolations()).toEqual([]);
  });

  it("the share press is one named button", async () => {
    await page();
    await screen.findByTestId("backing-box");
    expect(screen.getAllByRole("button", { name: "Share" })).toHaveLength(1);
  });
});

describe("the Share sheet", () => {
  const openShare = async () => {
    await screen.findByTestId("backing-box");
    fireEvent.click(screen.getByTestId("share-open"));
    return screen.findByTestId("share-sheet");
  };

  it("shows the project's own link, which shows only what the founder wrote, and copies it, saying so once", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: write },
    });
    await page();
    const sheet = await openShare();
    expect(sheet.textContent).toContain(
      "Anyone with the link can read the project. The link shows only what the founder wrote.",
    );
    const link = (within(sheet).getByTestId("share-link") as HTMLInputElement)
      .value;
    expect(link).toBe(
      `${window.location.origin}${projectPath({ id: ID, author: FOUNDER })}`,
    );
    fireEvent.click(within(sheet).getByTestId("share-copy"));
    await waitFor(() =>
      expect(within(sheet).getByTestId("share-said").textContent).toBe(
        "Link copied.",
      ),
    );
    expect(write).toHaveBeenCalledWith(link);
    expect(sheet.textContent).toContain(BANNER_LITERAL);
  });

  it("says plainly when the browser would not copy", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
    });
    await page();
    const sheet = await openShare();
    fireEvent.click(within(sheet).getByTestId("share-copy"));
    await waitFor(() =>
      expect(within(sheet).getByTestId("share-said").textContent).toMatch(
        /would not copy it/,
      ),
    );
  });

  it("offers the system's share only where it exists, with the link", async () => {
    await page();
    let sheet = await openShare();
    expect(within(sheet).queryByTestId("share-native")).toBeNull();
    cleanup();
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, share });
    await page();
    sheet = await openShare();
    fireEvent.click(within(sheet).getByTestId("share-native"));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0][0].url).toBe(
      `${window.location.origin}${projectPath({ id: ID, author: FOUNDER })}`,
    );
  });
});
