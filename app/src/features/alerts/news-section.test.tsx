// "News about your projects" on You: list semantics, one link per row, the sentence as a text node, marked read after it is
// drawn, "Mark {n} as read", the balance read where the holders list was cut, the 20-project limit said plainly, a record
// more than a day old, a read that failed (never "no news"), and a forged record that makes nothing.
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
  coordinateOf,
  DAY,
  NOW,
  projectEvent,
  recordV2,
  relayMock,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  chainIdentityV2,
  numbersV2Content,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  backerAnswers,
  nameTheNetwork,
  S,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
import {
  planTask,
  PLANNED_SERIAL,
  pointRow,
  sceneNumbers,
} from "../../../tests/helpers/plan-scene";
import type { ProjectTask } from "../tasks/task-record";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { taskRow } from "../../../tests/helpers/numbers-v2-fixture";
import { timeText } from "../money/numbers";
import { NEWS_FAILED, NEWS_NONE, NEWS_STALE } from "./alert-words";
import NewsSection from "./NewsSection";
import { readSeen } from "./seen";

const PUBKEY = "b".repeat(64);
let records: ProjectTask[] = [];
const navigated: unknown[] = [];
/** The projects the team's words were asked for. */
const wordsFor: string[] = [];

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("../tasks/use-tasks", async (actual) => ({
  ...(await actual<object>()),
  projectTasksQuery: (project: { coordinate: string }) => ({
    queryKey: ["news-test-tasks", project.coordinate],
    staleTime: 0,
    queryFn: async () => ({
      ...(wordsFor.push(project.coordinate), {}),
      tasks: records,
      agents: new Set<string>(),
      operators: new Map<string, string>(),
      complete: true,
    }),
  }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
  useNavigate: () => (to: unknown) => {
    navigated.push(to);
    return Promise.resolve();
  },
}));

const numbers = sceneNumbers();

interface Setup {
  patch?: (content: Record<string, unknown>, index: number) => void;
  shares?: bigint;
  /** The network the wallet is on, as a hex number (default: the project's). */
  chain?: string;
  /** The pubkey that signs the record. */
  signer?: string;
  projects?: number;
}

/** A server with `projects` Lantern-like projects (each its own record with the example's queue) and a chain that answers as `account`. */
function setup(account: string, o: Setup = {}) {
  const count = o.projects ?? 1;
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const coordinate = coordinateOf(i);
    const [, founder, id] = coordinate.split(":");
    events.push(
      projectEvent({
        author: founder as string,
        id: id as string,
        name: count === 1 ? "Lantern" : `Lantern ${i}`,
        chainKey: chainIdentityV2(coordinate).key,
      }),
      {
        ...recordV2(
          numbersV2Content({
            coordinate,
            now: NOW,
            patch: (content) => {
              withTasks()(content);
              o.patch?.(content, i);
            },
          }),
          coordinate,
          NOW,
        ),
        pubkey: o.signer ?? SERVER,
      },
    );
  }
  serve(events);
  return installPotChain({
    account,
    chain: o.chain,
    answers: {
      ...backerAnswers(numbers, { shares: o.shares ?? 0n }),
    } as never,
  });
}

const unlisted = (content: Record<string, unknown>) => {
  content.truncated = true;
};

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  records = [];
  navigated.length = 0;
  wordsFor.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

const rows = () => screen.getAllByTestId("news-row");

describe("the list", () => {
  it("is a list with a heading, the play-money line once, and a row for each piece of news with one link each", async () => {
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    const section = await screen.findByTestId("news-section");
    expect(
      within(section).getByRole("heading", {
        name: "News about your projects",
      }),
    ).toBeTruthy();
    const list = await within(section).findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items)
      expect(within(item).getAllByRole("link")).toHaveLength(1);
    expect(
      within(section).getAllByText(/play money, not real money/),
    ).toHaveLength(1);
    // The sentence is one plain line with the project in front.
    expect(items[0]?.textContent).toMatch(/^Lantern: /);
  });

  it("draws a plan still in its notice with a second line and a Take out that opens the project's Money tab", async () => {
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    const urgent = rows().filter((r) =>
      r.querySelector("[data-testid=news-urgent]"),
    );
    expect(urgent.length).toBeGreaterThan(0);
    const first = urgent[0] as HTMLElement;
    expect(within(first).getByTestId("news-urgent").textContent).toMatch(
      /^You can take your money out before /,
    );
    fireEvent.click(
      within(first).getByRole("button", {
        name: /^Take out of Lantern before /,
      }),
    );
    expect(navigated[0]).toMatchObject({
      to: "/p/$ref",
      search: { tab: "money" },
    });
    // A task nobody can take out of any more has no such button.
    const ended = rows().find((r) => r.getAttribute("data-kind") === "ended");
    expect(ended).toBeDefined();
    expect(within(ended as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("puts the planned and taken news first and says how the notice reaches a person: when the app is opened", async () => {
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    const kinds = rows().map((r) => r.getAttribute("data-kind"));
    expect(kinds.lastIndexOf("planned")).toBeLessThan(kinds.indexOf("ended"));
    expect(screen.getByTestId("news-week").textContent).toMatch(
      /open the app at least every 7 days/,
    );
  });

  it("draws one Take out for each project and date, though two plans share the date", async () => {
    setup(BACKER_EVM, {
      patch: (content) => {
        const tasks = content.tasks as Record<string, unknown>;
        taskRow(tasks, 8).noticeEnd = taskRow(tasks, 7).noticeEnd;
      },
    });
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(screen.getAllByTestId("news-urgent")).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /^Take out of Lantern before / }),
    ).toHaveLength(1);
  });

  it("asks for the team's words of at most 20 projects, and only of projects that have news", async () => {
    setup(BACKER_EVM, { projects: 22 });
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    await waitFor(() => expect(wordsFor.length).toBeGreaterThan(0));
    expect(new Set(wordsFor).size).toBe(20);
  });

  it("makes the sentence a plain text node: a task name with markup is words, never an element", async () => {
    const planned = sceneNumbers();
    setup(BACKER_EVM, {
      patch: (content) => {
        pointRow(content, PLANNED_SERIAL).payee = planTask().payTo;
      },
    });
    const row =
      planned.tasks && typeof planned.tasks === "object"
        ? planned.tasks.list.find((r) => r.serial === BigInt(PLANNED_SERIAL))
        : undefined;
    records = [
      planTask({
        usd: Number((row?.maxDollars ?? 0n) / 1_000_000n),
        what: "<img src=x onerror=alert(1)>‮ Fix the lamps",
      }),
    ];
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    const section = screen.getByTestId("news-section");
    expect(section.querySelector("img")).toBeNull();
    expect(section.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(section.textContent).not.toContain("‮");
  });
});

describe("marked read", () => {
  it("marks what it lists read after drawing it, and labels what was new this visit; a second visit has no labels", async () => {
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(rows().every((r) => r.getAttribute("data-unseen") === "true")).toBe(
      true,
    );
    await waitFor(() =>
      expect(Object.keys(readSeen(PUBKEY)).length).toBe(rows().length),
    );
    cleanup();
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(rows().every((r) => r.getAttribute("data-unseen") === "false")).toBe(
      true,
    );
    expect(screen.queryByTestId("news-mark-read")).toBeNull();
  });

  it("names the count on the button that marks it by hand, and a press clears the labels", async () => {
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    const button = screen.getByRole("button", { name: /^Mark \d+ as read$/ });
    expect(button.textContent).toBe(`Mark ${rows().length} as read`);
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByTestId("news-mark-read")).toBeNull(),
    );
    expect(rows().every((r) => r.getAttribute("data-unseen") === "false")).toBe(
      true,
    );
  });

  it("with storage that cannot be used, everything shows as new and the page still works", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(rows().every((r) => r.getAttribute("data-unseen") === "true")).toBe(
      true,
    );
  });
});

describe("whose news it is, and what is said when there is none", () => {
  it("an account the record does not list, with whole lists, has no news and is told so", async () => {
    setup(STRANGER_EVM);
    wrap(<NewsSection />);
    expect((await screen.findByTestId("news-none")).textContent).toBe(
      NEWS_NONE,
    );
    expect(screen.queryByTestId("news-list")).toBeNull();
  });

  it("where the holders list was cut, a balance read finds the news of an account that holds Shares", async () => {
    const chain = setup(STRANGER_EVM, { patch: unlisted, shares: 5n * S });
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(chain.reads.some((r) => r.name === "balanceOf")).toBe(true);
  });

  it("and says no news, not an error, when the balance read finds nothing held", async () => {
    setup(STRANGER_EVM, { patch: unlisted, shares: 0n });
    wrap(<NewsSection />);
    expect((await screen.findByTestId("news-none")).textContent).toBe(
      NEWS_NONE,
    );
  });

  it("says plainly that it reads at most 20 projects, and reads the balances of no more than that", async () => {
    const chain = setup(STRANGER_EVM, {
      patch: (content, i) => {
        unlisted(content);
        // Each project has contracts of its own, so each needs its own read.
        const contracts = content.contracts as Record<string, string>;
        contracts.shares = `0x${(0x1000 + i).toString(16).padStart(40, "0")}`;
        contracts.team = `0x${(0x2000 + i).toString(16).padStart(40, "0")}`;
      },
      shares: 5n * S,
      projects: 22,
    });
    chain.answers.balanceOf = () => [5n * S];
    wrap(<NewsSection />);
    await screen.findByTestId("news-limit");
    expect(screen.getByTestId("news-limit").textContent).toMatch(
      /up to 20 projects/,
    );
    // A share balance and a team balance for each of the 20 projects, and no more.
    expect(chain.reads.filter((r) => r.name === "balanceOf")).toHaveLength(40);
    const names = new Set(
      screen
        .getAllByTestId("news-row")
        .map((r) => r.textContent?.split(":")[0]),
    );
    expect(names.size).toBeLessThanOrEqual(20);
  });

  it("a wallet on another network says nothing about what is held: no news is made from a read it cannot answer, and the section says so", async () => {
    setup(STRANGER_EVM, { patch: unlisted, shares: 5n * S, chain: "0x1" });
    wrap(<NewsSection />);
    await screen.findByTestId("news-none");
    expect(screen.getByTestId("news-stale").textContent).toBe(NEWS_STALE);
  });

  it("lists at most 30 rows, newest first, whatever the projects give", async () => {
    setup(BACKER_EVM, { projects: 6 });
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(rows()).toHaveLength(30);
  });

  it("a record made by anyone but the server makes no news", async () => {
    setup(BACKER_EVM, { signer: "9".repeat(64) });
    wrap(<NewsSection />);
    expect((await screen.findByTestId("news-none")).textContent).toBe(
      NEWS_NONE,
    );
  });

  it("with no wallet shown it draws nothing", async () => {
    setup(BACKER_EVM);
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    wrap(<NewsSection />);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId("news-section")).toBeNull();
  });
});

describe("a record that is old, and a read that failed", () => {
  it("a record over a day old still shows its news, marked as out of date, and says some could not be refreshed", async () => {
    setup(BACKER_EVM, {
      patch: (content) => {
        content.builtAt = NOW - 2 * DAY;
      },
    });
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(rows()[0]?.textContent).toMatch(/may be out of date\)/);
    expect(screen.getByTestId("news-stale").textContent).toBe(NEWS_STALE);
  });

  it("never says no news for a read that failed: it says it could not be read, that the money is safe, and offers to try again", async () => {
    setup(BACKER_EVM);
    vi.spyOn(relayMock, "read").mockRejectedValue(new Error("down"));
    wrap(<NewsSection />);
    const failed = await screen.findByTestId("news-failed");
    expect(failed.textContent).toContain(NEWS_FAILED);
    expect(screen.queryByTestId("news-none")).toBeNull();
    expect(
      within(failed).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });
});

describe("a week later", () => {
  it("a holder who was away still sees the planned task before its date, with the right date, on a record that has gone old", async () => {
    // A plan with the notice the contracts give: at least 14 days, so a week later it is still in its notice.
    let noticeEnd = 0;
    setup(BACKER_EVM, {
      patch: (content) => {
        const at = (content.asOf as { time: number }).time;
        const row = taskRow(
          content.tasks as Record<string, unknown>,
          PLANNED_SERIAL,
        );
        noticeEnd = at + 14 * DAY;
        row.noticeEnd = noticeEnd;
        row.expiresAt = at + 21 * DAY;
        row.announcedAt = at - 60;
      },
    });
    // The app's own clock moves a week on; nothing else does.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((NOW + 7 * DAY) * 1000);
    try {
      wrap(<NewsSection />);
      await screen.findByTestId("news-list");
      const planned = rows().find(
        (r) =>
          r.getAttribute("data-kind") === "planned" &&
          r.querySelector("[data-testid=news-urgent]"),
      );
      expect(planned).toBeDefined();
      expect(planned?.textContent).toContain(`from ${timeText(noticeEnd)}`);
      expect(planned?.textContent).toMatch(/may be out of date\)/);
      expect(
        within(planned as HTMLElement).getByTestId("news-urgent").textContent,
      ).toBe(`You can take your money out before ${timeText(noticeEnd)}.`);
      expect(screen.getByTestId("news-stale")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assistive semantics", () => {
  it("has no serious violation: one heading, a list of rows, one link in each, a named button", async () => {
    setup(BACKER_EVM);
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    expect(await seriousViolations(screen.getByTestId("news-section"))).toEqual(
      [],
    );
    // No two controls share a name.
    const takeOuts = screen.getAllByRole("button", { name: /^Take out of / });
    expect(
      new Set(takeOuts.map((b) => b.getAttribute("aria-label"))).size,
    ).toBe(takeOuts.length);
  });
});
