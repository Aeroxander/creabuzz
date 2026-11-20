// Demo day, end to end against a mocked server: the season's entries, each checked again against its project, in the order
// the hash gives, 24 at a time, each with its money and last update, with the banner once and the lines the plan fixes.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { NOW, recordV2, SERVER } from "../../../tests/helpers/money-harness";
import {
  chainIdentityV2,
  numbersV2Content,
} from "../../../tests/helpers/numbers-v2-fixture";
import {
  DAY,
  OPERATOR,
  reads,
  type Stored,
  season,
  seasonRelayMock,
  serve,
  step,
  update,
} from "../../../tests/helpers/season-relay";
import { WithMoneyBanner } from "../../app/MoneyBanner";
import { ToastProvider } from "../../ui/toast";
import {
  NOT_A_RETURN,
  PLAY_MONEY_WORDS,
  smallDollarsText,
  TAKE_OUT_BANNER,
} from "../pot/pot-words";
import { SeasonPage } from "./SeasonPage";
import { inSeasonOrder } from "./season-order";
import { NOT_ADVICE } from "./season-words";
import { BATCH_SIZE } from "./use-demo-day";
import { PAGE_SIZE } from "./use-season";

vi.mock(
  "../../lib/relay",
  async () =>
    (await import("../../../tests/helpers/season-relay")).seasonRelayMock,
);

const founder = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const coordinate = (n: number) => `37001:${founder(n)}:p${n}`;
const letters = (n: number) =>
  String.fromCharCode(65 + (n % 26)) +
  String.fromCharCode(97 + Math.floor(n / 26));
const nameOf = (n: number) => `Project ${letters(n)}`;

function project(
  n: number,
  over: {
    team?: { who: string; invite: string }[];
    unlisted?: boolean;
    chainKey?: string;
  } = {},
): Stored {
  const tags = [
    ["d", `p${n}`],
    ["name", nameOf(n)],
    ["chain-key", over.chainKey ?? chainIdentityV2(coordinate(n)).key],
    ...(over.team ?? []).flatMap((m) => [
      ["team", m.who, "helper"],
      ["team-invite", m.who, m.invite],
      ["p", m.who],
    ]),
  ];
  return {
    id: `a${n}`.padStart(64, "0"),
    pubkey: founder(n),
    kind: 37001,
    created_at: NOW - DAY,
    tags,
    content: JSON.stringify({
      pitch: `What ${nameOf(n)} makes.`,
      ...(over.unlisted ? { listing: "unlisted" } : {}),
    }),
  };
}
/** The member's own yes to the invitation: what makes them speak for the project. */
const yes = (n: number, who: string, invite: string): Stored => ({
  id: `b${n}${who.slice(0, 2)}`.padStart(64, "0"),
  pubkey: who,
  kind: 47003,
  created_at: NOW - 3 * DAY,
  tags: [
    ["a", coordinate(n)],
    ["l", "creaton-team"],
    ["team-answer", "yes"],
    ["team-invite", invite],
  ],
  content: "{}",
});
const numbers = (n: number, potScale: number, now = NOW): Stored =>
  recordV2(
    numbersV2Content({
      coordinate: coordinate(n),
      now,
      patch: (c) => {
        const money = c.money as Record<string, string>;
        money.pot = (BigInt(money.pot) * BigInt(potScale)).toString();
      },
    }),
    coordinate(n),
    now,
  ) as Stored;

const live = season(7, { start: -43, demo: -1, end: 6 });
const entry = (n: number, signer = founder(n)) =>
  step(7, coordinate(n), "entry", signer, 5_000 + n);

function page(number = 7, banner = false) {
  const root = createRootRoute({
    component: () =>
      banner ? (
        <WithMoneyBanner>
          <SeasonPage number={number} />
        </WithMoneyBanner>
      ) : (
        <SeasonPage number={number} />
      ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([stub("/p/$ref"), stub("/season/$n")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const cardNames = () =>
  screen
    .getAllByTestId("demo-card")
    .map((c) => within(c).getByRole("heading").textContent);

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("the demo day page", () => {
  it("lists the projects that entered, in the hash's order and not in the order they entered or by money", async () => {
    const ns = [1, 2, 3, 4, 5, 6];
    serve([
      live,
      ...ns.map((n) => project(n)),
      ...ns.map((n) => entry(n)),
      // The first to enter has by far the most money: it still takes no place for it.
      numbers(1, 1000),
      ...ns.slice(1).map((n) => numbers(n, 1)),
    ]);
    page();
    await screen.findByTestId("demo-cards");
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(6),
    );
    const want = inSeasonOrder(7, ns.map(coordinate)).map((c) =>
      nameOf(Number(/p(\d+)$/.exec(c)?.[1])),
    );
    expect(cardNames()).toEqual(want);
    expect(screen.getByTestId("demo-cards").tagName).toBe("OL");
  });

  it("does not list a project that left, was removed, was never entered, is unlisted or not launched", async () => {
    serve([
      live,
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => project(n)),
      project(8, { unlisted: true }),
      project(9, { chainKey: "" }),
      entry(1),
      entry(2),
      step(7, coordinate(2), "leave", founder(2), 1_000),
      entry(3),
      step(7, coordinate(3), "remove", OPERATOR, 1_000),
      entry(4),
      entry(8),
      entry(9),
    ]);
    page();
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(2),
    );
    expect(cardNames().sort()).toEqual([nameOf(1), nameOf(4)].sort());
  });

  it("an entry signed by a stranger is not listed, and a stranger's leave does not take a project out", async () => {
    const stranger = "d".repeat(64);
    serve([
      live,
      project(1),
      project(2),
      // 1: entered by a stranger. 2: entered by its founder, "left" by a stranger afterwards.
      entry(1, stranger),
      entry(2),
      step(7, coordinate(2), "leave", stranger, 10),
    ]);
    page();
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(1),
    );
    expect(cardNames()).toEqual([nameOf(2)]);
  });

  it("a team member's entry counts only once the member has said yes to the invitation", async () => {
    const member = "e".repeat(64);
    serve([
      live,
      project(1, { team: [{ who: member, invite: "inv1" }] }),
      project(2, { team: [{ who: member, invite: "inv2" }] }),
      yes(1, member, "inv1"),
      // Project 2: the member never answered.
      entry(1, member),
      entry(2, member),
    ]);
    page();
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(1),
    );
    expect(cardNames()).toEqual([nameOf(1)]);
  });

  it("shows 24 at a time, and Show more reads only the next 24", async () => {
    const ns = Array.from({ length: 30 }, (_, i) => i + 1);
    serve([live, ...ns.map((n) => project(n)), ...ns.map((n) => entry(n))]);
    page();
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(BATCH_SIZE),
    );
    const order = inSeasonOrder(7, ns.map(coordinate));
    expect(
      screen
        .getAllByTestId("demo-card")
        .map((c) => within(c).getByRole("heading").textContent),
    ).toEqual(
      order
        .slice(0, BATCH_SIZE)
        .map((c) => nameOf(Number(/p(\d+)$/.exec(c)?.[1]))),
    );
    const recordReads = () =>
      reads.filter((f) => f.kinds?.includes(37001)).length;
    expect(recordReads()).toBe(BATCH_SIZE);
    fireEvent.click(screen.getByTestId("demo-more"));
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(30),
    );
    expect(recordReads()).toBe(30);
    // The keyboard is where the button was: on the first card of the batch that was asked for.
    const firstNew = document.querySelector('[data-batch="1"] a');
    expect(firstNew).not.toBeNull();
    expect(document.activeElement).toBe(firstNew);
    expect(screen.queryByTestId("demo-more")).toBeNull();
  });
});

describe("a card", () => {
  it("shows the name, the line, the project's money and the team's last update, and one press to open it", async () => {
    serve([
      live,
      project(1),
      entry(1),
      numbers(1, 2),
      // The newest update by the team, an older one, one by a stranger that is newer, and records that are not updates.
      update(
        coordinate(1),
        founder(1),
        {
          title: "Shipped the first part",
          body: "We finished the base and tested it with ten people today.",
        },
        7_200,
      ),
      update(
        coordinate(1),
        founder(1),
        { title: "Older", body: "older" },
        90_000,
      ),
      update(
        coordinate(1),
        "d".repeat(64),
        { title: "A stranger's words", body: "x" },
        60,
      ),
      step(7, coordinate(1), "leave", "d".repeat(64), 30),
    ]);
    page();
    const card = await screen.findByTestId("demo-card");
    await within(card).findByText("Shipped the first part");
    expect(within(card).getByRole("heading").textContent).toBe(nameOf(1));
    expect(card.textContent).toContain(`What ${nameOf(1)} makes.`);
    expect(within(card).getByTestId("demo-money").textContent).toMatch(
      /^The project's money /,
    );
    expect(within(card).getByTestId("demo-update").textContent).toContain(
      "We finished the base",
    );
    expect(card.textContent).not.toContain("A stranger");
    expect(card.textContent).not.toContain("Older");
    const open = within(card).getByRole("link", {
      name: `Open project ${nameOf(1)}`,
    });
    expect(open.textContent).toBe("Open project");
    expect(open.getAttribute("href")).toMatch(/^\/p\/p1-/);
    // That is the card's only press.
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

  it("the money is the pot as the project's page says it, and nothing else about money is on the card", async () => {
    serve([live, project(1), entry(1), numbers(1, 3)]);
    page();
    const card = await screen.findByTestId("demo-card");
    const money = await within(card).findByText(/The project's money/);
    const text = money.textContent ?? "";
    expect(text).toMatch(/^The project's money [0-9,]+(\.\d+)?$/);
    const pot =
      BigInt(
        (
          numbersV2Content({ coordinate: coordinate(1), now: NOW })
            .money as Record<string, string>
        ).pot,
      ) * 3n;
    expect(text).toBe(`The project's money ${smallDollarsText(pot)}`);
    expect(card.textContent).not.toMatch(
      /price|per share|return|profit|gain|volume|joined|took out/i,
    );
  });

  it("a project with no numbers yet says so, with no figure and no zero; one with old numbers says they could not be refreshed", async () => {
    serve([
      live,
      project(1),
      project(2),
      entry(1),
      entry(2),
      numbers(2, 1, NOW - 3 * DAY),
    ]);
    page();
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(2),
    );
    const money = (name: string) =>
      within(
        screen
          .getAllByTestId("demo-card")
          .find((c) => c.textContent?.includes(name)) as HTMLElement,
      ).getByTestId("demo-money").textContent;
    expect(money(nameOf(1))).toBe("Its numbers are not here yet.");
    expect(money(nameOf(2))).toBe("Its numbers could not be refreshed.");
  });

  it("a project with no update says so", async () => {
    serve([live, project(1), entry(1)]);
    page();
    const card = await screen.findByTestId("demo-card");
    expect(within(card).getByTestId("demo-update").textContent).toBe(
      "No update yet.",
    );
  });
});

describe("the page", () => {
  it("says the line once under the list's heading, the banner once, the play-money line and the note, and the shell's banner steps aside", async () => {
    serve([live, project(1), entry(1)]);
    page(7, true);
    const section = await screen.findByTestId("demo-list");
    await screen.findByTestId("demo-card");
    const heading = within(section).getByRole("heading", {
      name: "Projects showing what they made",
    });
    expect(heading.nextElementSibling?.textContent).toBe(NOT_A_RETURN);
    expect(document.body.textContent?.split(NOT_A_RETURN).length).toBe(2);
    expect(screen.getAllByTestId("money-banner")).toHaveLength(1);
    expect(screen.getByTestId("money-banner").textContent).toBe(
      TAKE_OUT_BANNER,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("shell-banner")).toBeNull(),
    );
    expect(screen.getByTestId("demo-play-money").textContent).toBe(
      PLAY_MONEY_WORDS,
    );
    expect(screen.getByTestId("demo-not-advice").textContent).toBe(NOT_ADVICE);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Season 7",
    );
  });

  it("has no serious accessibility violation with cards on it", async () => {
    serve([live, project(1), project(2), entry(1), entry(2), numbers(1, 1)]);
    page();
    await waitFor(() =>
      expect(screen.getAllByTestId("demo-card")).toHaveLength(2),
    );
    await screen.findAllByText(/The project's money|Its numbers/);
    expect(await seriousViolations()).toEqual([]);
  });

  it("says plainly when nobody entered, and when the season is not on this server", async () => {
    serve([live]);
    page();
    await screen.findByTestId("demo-empty");
    cleanup();
    serve([live]);
    page(9);
    await screen.findByText("This season could not be found on this server.");
    cleanup();
    // An address that is not a number reads nothing.
    serve([live]);
    page(0);
    await screen.findByText("This season could not be found on this server.");
    expect(reads.some((f) => f["#t"])).toBe(false);
  });

  it("reads nothing where the server does not offer investing", async () => {
    applyServerSettings(null);
    serve([live, project(1), entry(1)]);
    page();
    await screen.findByText("Seasons are not shown here");
    expect(reads).toHaveLength(0);
  });

  it("a read that fails says so and offers to try again, never an empty list", async () => {
    serve([live, project(1), entry(1)]);
    const failing = vi
      .spyOn(seasonRelayMock, "read")
      .mockRejectedValueOnce(new Error("down"));
    page();
    await screen.findByText("The season could not be read. Try again.");
    expect(screen.queryByTestId("demo-empty")).toBeNull();
    failing.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("demo-card");
  });
});

describe("a season with more entries than one read holds", () => {
  const id64 = (n: number) => n.toString(16).padStart(64, "0");
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      step(7, `37001:${id64(1000 + i)}:p`, "entry", id64(1000 + i), 5_000 + i),
    );

  it("follows the pages, at most three, and says it did not read all of a longer season", async () => {
    serve([live, ...many(PAGE_SIZE * 3 + 50)]);
    page();
    await screen.findByTestId("demo-trim");
    const entryReads = reads.filter((f) => f["#t"]);
    // Three pages, whatever more there is: the server never holds more than that for one season.
    expect(entryReads).toHaveLength(3);
    // Each page starts where the last stopped.
    expect(entryReads[0].until).toBeUndefined();
    expect(entryReads[1].until).toBeLessThanOrEqual(NOW - 5_000);
  });

  it("reads a season of two pages as two reads and does not say it is cut", async () => {
    serve([live, ...many(PAGE_SIZE + 30), ...[]]);
    page();
    await screen.findByTestId("demo-cards");
    expect(reads.filter((f) => f["#t"])).toHaveLength(2);
    expect(screen.queryByTestId("demo-trim")).toBeNull();
  });
});
