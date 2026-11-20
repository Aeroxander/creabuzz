// "Money that stayed" on Home, end to end against a mocked server: the server's index and the projects' own records. The money
// and the people are the example's own, scaled by arithmetic; the index is the labelled shape-only one (the server has no real
// example of it, `RECORD-V2.md` section 11.6).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installWallet,
  NOW,
  relayMock,
  SERVER,
  projectEvent,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  chainIdentityV2,
  type ShapeOnlyEntry,
  shapeOnlyIndexContent,
} from "../../../tests/helpers/numbers-v2-fixture";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import {
  NOT_A_RETURN,
  PLAY_MONEY_WORDS,
  smallDollarsText,
} from "../pot/pot-words";
import { HomePage } from "./HomePage";
import { rankedEmpty, rankedFootnote } from "./RankedSection";

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
  useRouterState: () => ({ location: { pathname: "/", search: "" } }),
}));

const rank = parsedExample().held?.rank;
if (!rank) throw new Error("the example has no ranking window");
const WINDOW = parsedExample().held?.windows.rankSecs ?? 0;
const founder = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const idOf = (n: number) => `p${n}`;
// A letter for a name: a name never ends in a digit that a line of money could be mistaken for.
const letter = (n: number) => String.fromCharCode(64 + n);
const coordinate = (n: number) => `37001:${founder(n)}:${idOf(n)}`;
const keyOf = (n: number) => chainIdentityV2(coordinate(n)).key;
const times = (k: number) => ((rank?.money ?? 0n) * BigInt(k)).toString();

function project(
  n: number,
  over: { at?: number; unlisted?: boolean; chainKey?: string } = {},
) {
  const e = projectEvent({
    author: founder(n),
    id: idOf(n),
    name: `Project ${letter(n)}`,
    chainKey: over.chainKey ?? keyOf(n),
    at: over.at ?? NOW - n * 3600,
  });
  return over.unlisted
    ? { ...e, content: JSON.stringify({ listing: "unlisted" }) }
    : e;
}
function entry(n: number, over: Partial<ShapeOnlyEntry> = {}): ShapeOnlyEntry {
  return {
    key: keyOf(n),
    a: coordinate(n),
    launchedAt: NOW - 100 * WINDOW,
    windowSecs: WINDOW,
    money: rank?.money.toString() ?? "0",
    accounts: rank?.accounts ?? 0,
    reached: false,
    ...over,
  };
}
function index(entries: ShapeOnlyEntry[], over: Record<string, unknown> = {}) {
  return {
    id: "7".repeat(64),
    pubkey: SERVER,
    kind: 39009,
    created_at: NOW - 120,
    tags: [["d", "explore"]],
    content: JSON.stringify(shapeOnlyIndexContent(entries, { now: NOW })),
    ...over,
  };
}
async function home(...events: ReturnType<typeof project>[] | unknown[]) {
  serve(events as never);
  wrap(<HomePage />);
  await screen.findByTestId("home-projects");
}
const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((li) => /^Project ([A-Z])/.exec(li.textContent ?? "")?.[1]);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  applyServerSettings(null);
});

describe("Money that stayed", () => {
  it("lists the projects in the app's own order, with the money and the people from the index", async () => {
    // The index comes in the wrong order on purpose.
    await home(
      project(1),
      project(2),
      project(3),
      index([
        entry(3, { money: times(1) }),
        entry(1, { money: times(3) }),
        entry(2, {
          money: times(2),
          accounts: rank.accounts + 5,
          reached: true,
        }),
      ]),
    );
    const list = await screen.findByTestId("ranked-list");
    expect(list.tagName).toBe("OL");
    expect(names(list)).toEqual(["A", "B", "C"]);
    const first = within(list).getAllByRole("listitem")[0];
    expect(first.textContent).toContain(
      `${smallDollarsText(BigInt(times(3)))} kept 30 days or more by ${rank.accounts} people.`,
    );
  });

  it("puts the line under the heading once, says what the ranking is not, and says it is play money", async () => {
    await home(project(1), index([entry(1)]));
    const section = await screen.findByTestId("home-ranked");
    expect(
      within(section).getByRole("heading", { name: "Money that stayed" }),
    ).not.toBeNull();
    expect(section.textContent?.split(NOT_A_RETURN).length).toBe(2);
    const heading = within(section).getByRole("heading");
    expect(heading.nextElementSibling?.textContent).toBe(NOT_A_RETURN);
    expect(within(section).getByTestId("ranked-footnote").textContent).toBe(
      rankedFootnote(WINDOW),
    );
    expect(rankedFootnote(WINDOW)).toMatch(
      /among the projects this server has numbers for/,
    );
    expect(rankedFootnote(WINDOW)).toMatch(/not a price and not a promise/);
    expect(within(section).getByTestId("ranked-play-money").textContent).toBe(
      PLAY_MONEY_WORDS,
    );
  });

  it("one link per row, and the Established chip is text inside it, never a second stop", async () => {
    await home(
      project(1),
      project(2),
      index([entry(1, { reached: true }), entry(2)]),
    );
    const list = await screen.findByTestId("ranked-list");
    for (const li of within(list).getAllByRole("listitem")) {
      expect(within(li).getAllByRole("link")).toHaveLength(1);
      expect(within(li).queryAllByRole("button")).toHaveLength(0);
    }
    const chip = within(list).getByText("Established");
    expect(chip.closest("a")).not.toBeNull();
    expect(within(list).getAllByText("Established")).toHaveLength(1);
  });

  it("a project with a huge pot and nothing that stayed is not in the list; Shipping now keeps its newest-first order", async () => {
    // Project 4 is the newest and has the most money in it; the index does not name it.
    await home(
      project(4, { at: NOW - 60 }),
      project(1),
      project(2),
      project(3),
      index([entry(3, { money: times(5) }), entry(1, { money: times(9) })]),
    );
    const list = await screen.findByTestId("ranked-list");
    expect(names(list)).toEqual(["A", "C"]);
    const shipping = screen.getByTestId("home-projects");
    expect(
      within(shipping)
        .getAllByRole("heading", { level: 3 })
        .map((h) => /^Project ([A-Z])/.exec(h.textContent ?? "")?.[1]),
    ).toEqual(["D", "A", "B", "C"]);
  });

  it("an entry whose record is missing, unlisted or names another launch is left out", async () => {
    await home(
      project(1),
      project(2, { unlisted: true }),
      project(3, { chainKey: keyOf(9) }),
      index([entry(1), entry(2), entry(3), entry(4)]),
    );
    const list = await screen.findByTestId("ranked-list");
    expect(names(list)).toEqual(["A"]);
  });

  it("with every entry left out it says so in the index's own window, and never that the list is whole", async () => {
    // A project the index does not name keeps Home from its empty state (which needs a router this test does not mount).
    await home(project(9), index([entry(1)]));
    const empty = await screen.findByTestId("ranked-empty");
    expect(empty.textContent).toBe(rankedEmpty(WINDOW));
    expect(rankedEmpty(WINDOW)).toBe(
      "No project has money that has stayed 30 days yet.",
    );
  });

  it("reads the records of the first ten entries and shows at most eight", async () => {
    const spy = vi.spyOn(relayMock, "readMulti");
    const ns = Array.from({ length: 12 }, (_, i) => i + 1);
    await home(
      ...ns.map((n) => project(n)),
      index(ns.map((n) => entry(n, { money: times(100 - n) }))),
    );
    const list = await screen.findByTestId("ranked-list");
    expect(names(list)).toEqual(ns.slice(0, 8).map(letter));
    const asked = spy.mock.calls.map((c) => c[0].length);
    expect(Math.max(...asked)).toBe(10);
  });

  it("is not drawn for an index from another key, an old one, or none; nothing else on Home changes", async () => {
    for (const bad of [
      index([entry(1)], { pubkey: "e".repeat(64) }),
      index([entry(1)], { created_at: NOW - 25 * 3600 }),
      index([entry(1)], { tags: [["d", "elsewhere"]] }),
    ]) {
      cleanup();
      await home(project(1), bad);
      expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(
        1,
      );
      expect(screen.queryByTestId("home-ranked")).toBeNull();
    }
    cleanup();
    await home(project(1));
    expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(1);
    expect(screen.queryByTestId("home-ranked")).toBeNull();
  });

  it("is not asked for, and not drawn, where the server does not offer investing", async () => {
    applyServerSettings(null);
    const spy = vi.spyOn(relayMock, "read");
    await home(project(1), index([entry(1)]));
    expect(screen.queryByTestId("home-ranked")).toBeNull();
    expect(
      spy.mock.calls.filter((c) => (c[0].kinds as number[])?.includes(39009)),
    ).toHaveLength(0);
  });

  it("the newest believable index is the one used", async () => {
    await home(
      project(1),
      project(2),
      index([entry(1)], { id: "1".repeat(64), created_at: NOW - 3000 }),
      index([entry(2)], { id: "2".repeat(64), created_at: NOW - 100 }),
      index([entry(1)], {
        id: "3".repeat(64),
        created_at: NOW - 50,
        pubkey: "e".repeat(64),
      }),
    );
    expect(names(await screen.findByTestId("ranked-list"))).toEqual(["B"]);
  });
});
