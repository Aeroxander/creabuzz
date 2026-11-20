// The Tasks tab with a task queue: plans that are open first, then the other tasks, then plans that ended; a plan with no task
// record here has its own card; the one line when the server's record has no queue (or one that could not be read); the line when
// the record is over a day old; the team's reminder to check in; the play-money line; and list semantics.
import { cleanup, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import {
  FOUNDER_KEY,
  planTask,
  pointRow,
  queueOf,
  sceneNumbers,
  WORKER,
} from "../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { TasksTab } from "./TasksTab";
import type { ProjectTask } from "./task-record";

let pubkey: string | null = FOUNDER_KEY;
let records: ProjectTask[] = [];

vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey, locked: false }),
}));
vi.mock("./use-tasks", () => ({
  teamOf: () => new Set([FOUNDER_KEY]),
  freshTask: async () => null,
  useProjectTasks: () => ({
    isPending: false,
    isError: false,
    data: {
      tasks: records,
      agents: new Set<string>(),
      operators: new Map<string, string>(),
      complete: true,
    },
  }),
  useTaskWrite: () => ({ isPending: false, mutate: () => {} }),
}));
vi.mock("../money/use-money", () => ({
  useMoneySend: () => ({ isPending: false, send: () => {} }),
  useConnectWallet: () => ({ isPending: false, mutateAsync: async () => null }),
  useWallet: () => ({
    readCall: async () => "0x",
    blockNumber: async () => 1,
    getLogs: async () => [],
  }),
  useWalletAddress: () => ({ data: null }),
  useWalletOnChain: () => true,
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/week">{children}</a>
  ),
}));

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;
const PIECE = "1".repeat(64);

function show(numbers: ProjectNumbers | null) {
  return wrap(
    <TasksTab
      address={null}
      numbers={numbers}
      profiles={undefined}
      project={project}
    />,
  );
}

afterEach(() => {
  cleanup();
  pubkey = FOUNDER_KEY;
  records = [];
});

/** A scene whose rows 6 (taken), 2 (paid) and 3 (sent back) name team records, and a plain task that has no plan. */
function scene(patch?: (content: Record<string, unknown>) => void) {
  const numbers = sceneNumbers((content) => {
    pointRow(content, 6, "6".repeat(64));
    pointRow(content, 2, "2".repeat(64));
    patch?.(content);
  });
  const taken = planTask({ id: "6".repeat(64), what: "Draw the cover" });
  const paid = planTask({
    id: "2".repeat(64),
    what: "Fix the build",
    state: "accepted",
    paidTx: `0x${"ab".repeat(32)}`,
  });
  const plain = planTask({
    id: "5".repeat(64),
    what: "Write the thanks",
    state: "submitted",
    handIn: { id: PIECE, at: 1, note: "done" },
  });
  records = [paid, plain, taken];
  return numbers;
}

describe("the Tasks tab with a task queue", () => {
  it("lists plans that are open first, then the other tasks, then plans that ended, each group a list of articles", () => {
    show(scene());
    const planned = screen.getByTestId("tasks-planned");
    const others = screen.getByTestId("tasks-others");
    const ended = screen.getByTestId("tasks-ended");
    expect(within(planned).getByText("Draw the cover")).toBeTruthy();
    expect(within(others).getByText("Write the thanks")).toBeTruthy();
    expect(within(ended).getByText("Fix the build")).toBeTruthy();
    const order = [planned, others, ended].map((s) =>
      Array.from(document.body.querySelectorAll("section")).indexOf(s),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // A list of articles, each with a name.
    const items = within(planned).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    for (const article of within(planned).getAllByRole("article"))
      expect(article.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Planned and running" })).toBe(
      planned,
    );
  });

  it("gives a plan that no task here names its own card, with the network's numbers", () => {
    show(scene());
    const cards = screen.getAllByTestId("plan-only-card");
    expect(cards.length).toBeGreaterThan(0);
    const row = queueOf(scene()).list.find(
      (r) => r.state === "announced" && r.repeatOf === null,
    );
    expect(row).toBeTruthy();
    expect(
      cards.some((c) =>
        /^A planned task with no matching task here: /.test(
          c.querySelector("h3")?.textContent ?? "",
        ),
      ),
    ).toBe(true);
    // Its state is the network's headline, in one paragraph with the state as data.
    expect(
      within(cards[0] as HTMLElement).getByTestId("plan-only-state")
        .textContent,
    ).toMatch(/Planned|Can be taken|Taken/);
  });

  it("marks a second plan of a task that is already planned, so no live plan is out of sight", () => {
    show(scene());
    const repeats = screen.getAllByTestId("plan-only-repeat");
    expect(repeats[0]?.textContent).toMatch(/second plan .* came first/);
  });

  it("says it is play money, once, at the top", () => {
    show(scene());
    expect(screen.getByTestId("tasks-play-money").textContent).toMatch(
      /play money/,
    );
  });

  it("reminds the team to check in when a planned task cannot be taken unless they do, and no one else", () => {
    const soon = scene((content) => {
      (content.clock as { activeUntil: number }).activeUntil =
        (content.asOf as { time: number }).time + 100;
    });
    show(soon);
    expect(screen.getByTestId("check-in-line").textContent).toMatch(
      /can be taken from .*, but nobody can take .* unless the project checks in again before .*Check in on This week\./,
    );
    cleanup();
    pubkey = WORKER;
    show(soon);
    expect(screen.queryByTestId("check-in-line")).toBeNull();
  });

  it("says nothing about check-in when the last one counts past every take window", () => {
    show(
      scene((content) => {
        (content.clock as { activeUntil: number }).activeUntil =
          (content.asOf as { time: number }).time + 100 * 86_400;
      }),
    );
    expect(screen.queryByTestId("check-in-line")).toBeNull();
  });

  it("says the tasks could not be refreshed when the record is over a day old, and that the money is not affected", () => {
    show(
      scene((content) => {
        content.builtAt = (content.builtAt as number) - 2 * 86_400;
      }),
    );
    expect(screen.getByTestId("tasks-stale").textContent).toMatch(
      /^We have not been able to refresh this project's tasks since .*Your money is not affected: you can take it out any time\.$/,
    );
  });
});

describe("a record with no queue", () => {
  it("says once that the server has not told us about the tasks, and keeps the step 1 tasks", () => {
    records = [planTask({ state: "working" })];
    show(
      sceneNumbers((content) => {
        delete content.tasks;
      }),
    );
    expect(screen.getByTestId("tasks-queue-line").textContent).toBe(
      "This server has not told us about this project's tasks yet.",
    );
    expect(screen.getByText("Translate the guide")).toBeTruthy();
    expect(screen.queryByTestId("tasks-planned")).toBeNull();
  });

  it("says a queue that could not be read could not be read, and that leaving is not affected", () => {
    records = [planTask({ state: "working" })];
    const numbers = {
      ...sceneNumbers(),
      tasks: "unreadable",
    } as unknown as ProjectNumbers;
    show(numbers);
    expect(screen.getByTestId("tasks-queue-line").textContent).toBe(
      "The task list could not be read. Your money is not affected: you can take it out any time.",
    );
    expect(screen.getByText("Translate the guide")).toBeTruthy();
  });

  it("says nothing about a queue where money is off, and keeps the empty state", () => {
    records = [];
    show(null);
    expect(screen.queryByTestId("tasks-queue-line")).toBeNull();
    expect(screen.getByTestId("tasks-none").textContent).toMatch(
      /No tasks yet/,
    );
  });
});
