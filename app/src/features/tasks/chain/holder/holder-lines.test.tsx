// What everyone reads about a planned or running task: the two lines on a card, the strips above the tabs and the Money
// tab's section. Every number is read from the parsed example (never copied), and a row is changed through `withTasks`.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../../../tests/helpers/money-harness";
import {
  FOUNDER_KEY,
  PLANNED_SERIAL,
  planTask,
  plannedNumbers,
  plannedRowOf,
  queueOf,
  sceneNumbers,
  takenNumbers,
  takenRowOf,
  WORKER,
} from "../../../../../tests/helpers/plan-scene";
import { taskRow } from "../../../../../tests/helpers/numbers-v2-fixture";
import { timeText, type ProjectNumbers } from "../../../money/numbers";
import { smallDollarsText } from "../../../money/copy";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import { chainRowOf, nowOf } from "../state";
import type { ChainTask } from "../types";
import { PlannedLines } from "./PlannedLines";
import { PlannedSection } from "./PlannedSection";
import { PlannedStrips } from "./PlannedStrips";

let records: ProjectTask[] = [];

vi.mock("../../use-tasks", () => ({
  useProjectTasks: () => ({
    isPending: false,
    isError: false,
    data: {
      tasks: records,
      agents: new Set<string>(),
      operators: new Map<string, string>(),
      complete: true,
    },
    refetch: () => {},
  }),
}));
vi.mock("../../../../lib/profiles", async (actual) => ({
  ...(await actual<object>()),
  useProfiles: () => ({ data: { [WORKER]: { name: "Pat" } } }),
}));
vi.mock("../../../money/use-money", () => ({
  useMoneySend: () => ({ isPending: false, send: () => {} }),
  useConnectWallet: () => ({ isPending: false, mutateAsync: async () => null }),
  useWallet: () => ({ isAvailable: () => false }),
  useWalletAddress: () => ({ data: null }),
  useWalletOnChain: () => true,
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
  name: "Orbit",
  team: [],
} as unknown as Project;

afterEach(() => {
  cleanup();
  records = [];
});

const dollars = (raw: bigint) => `${smallDollarsText(raw)} dollars`;

interface LinesProps {
  task: ProjectTask;
  chain: ChainTask | null;
  numbers: ProjectNumbers;
  now: number;
}

function props(numbers: ProjectNumbers, task: ProjectTask): LinesProps {
  return {
    task,
    chain: chainRowOf(queueOf(numbers), task.id),
    numbers,
    now: nowOf(numbers.asOf.time),
  };
}

/** The two lines of a plan on a task's own row: nothing for a task that was taken or has ended. */
function HolderLines({ chain, task, numbers, now }: LinesProps) {
  if (chain?.state !== "announced") return null;
  return (
    <PlannedLines
      now={now}
      numbers={numbers}
      profiles={{ [WORKER]: { name: "Pat" } }}
      row={chain}
      task={task}
      withAge={false}
    />
  );
}

describe("a planned task in two lines, on its card", () => {
  it("names who is paid, how much at most, from when, and that people can take out first", () => {
    const numbers = plannedNumbers();
    const row = plannedRowOf(numbers);
    const task = planTask({ usd: Number(row.maxDollars / 1_000_000n) });
    wrap(<HolderLines {...props(numbers, task)} />);
    expect(screen.getByTestId("planned-line-1").textContent).toBe(
      `The team plans to pay up to ${dollars(row.maxDollars)} to Pat for “Translate the guide”, from ${timeText(row.noticeEnd)}.`,
    );
    expect(screen.getByTestId("planned-line-2").textContent).toBe(
      `You can take your money out before then. ${dollars(row.maxDollars)} is the most; it can be less if people take out first.`,
    );
  });

  it("says whoever takes it when the plan names nobody, and a task when it does not tie to a record here", () => {
    const numbers = plannedNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      row.payee = null;
    });
    const task = planTask({ usd: 1 });
    wrap(<HolderLines {...props(numbers, task)} />);
    const line = screen.getByTestId("planned-line-1").textContent ?? "";
    expect(line).toContain("to whoever takes it for a task, from");
    expect(line).not.toContain("Translate the guide");
  });

  it("says how much would be set aside today, which can be less than the most, and that it is not a return", () => {
    const numbers = plannedNumbers();
    const row = plannedRowOf(numbers);
    expect(row.atMostNow).not.toBeNull();
    expect(row.atMostNow as bigint).toBeLessThan(row.maxDollars);
    wrap(<HolderLines {...props(numbers, planTask())} />);
    expect(screen.getByTestId("planned-now").textContent).toBe(
      `${dollars(row.atMostNow as bigint)} would be set aside today (a share of the project's money). This can go up or down. It is not a return.`,
    );
  });

  it("says it can be taken until a date once the notice is over, and that leaving works any day", () => {
    const numbers = plannedNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      row.noticeEnd = (content.asOf as { time: number }).time - 60;
    });
    const row = plannedRowOf(numbers);
    wrap(<HolderLines {...props(numbers, planTask())} />);
    expect(screen.getByTestId("planned-line-1").textContent).toContain(
      `It can be taken until ${timeText(row.expiresAt)}.`,
    );
    expect(screen.getByTestId("planned-line-2").textContent).toMatch(
      /^You can take your money out any time\./,
    );
  });

  it("names the wallet by its start and end when the record's person did not name that wallet, and by their name when they did", () => {
    const numbers = plannedNumbers();
    const row = plannedRowOf(numbers);
    const other = planTask({
      usd: Number(row.maxDollars / 1_000_000n),
      payTo: "0x00000000000000000000000000000000000000ee",
    });
    wrap(<HolderLines {...props(numbers, other)} />);
    const line = screen.getByTestId("planned-line-1").textContent ?? "";
    expect(line).not.toContain("Pat");
    expect(line).toMatch(/to 0x[0-9a-f]{4}…[0-9a-f]{4} for /);
  });

  it("draws nothing for a row that is not a plan or a task in progress", () => {
    const numbers = plannedNumbers();
    const ended = queueOf(numbers).list.find((r) => r.state === "returned");
    if (!ended) throw new Error("no ended row");
    const { container } = wrap(
      <PlannedLines
        now={nowOf(numbers.asOf.time)}
        numbers={numbers}
        profiles={undefined}
        row={ended}
        task={null}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("lets the date wrap on a phone, and draws nothing for a task that was taken (the card's headline says it)", () => {
    const numbers = plannedNumbers();
    wrap(<HolderLines {...props(numbers, planTask())} />);
    for (const id of ["planned-line-1", "planned-line-2", "planned-now"])
      expect(screen.getByTestId(id).className).toContain("break-words");
    cleanup();
    const taken = takenNumbers();
    const { container } = wrap(<HolderLines {...props(taken, planTask())} />);
    expect(container.textContent).toBe("");
  });
});

function strips(
  numbers: ProjectNumbers,
  over: { address?: string | null; tasks?: ProjectTask[] } = {},
) {
  records = over.tasks ?? [];
  const calls = { money: 0 };
  wrap(
    <PlannedStrips
      address={over.address ?? null}
      numbers={numbers}
      onOpenMoney={() => {
        calls.money += 1;
      }}
      project={project}
    />,
  );
  return calls;
}

/** The scene with `extra` more announced rows, so there are more open tasks than the page shows. */
function crowded(extra: number) {
  return sceneNumbers((content) => {
    const tasks = content.tasks as Record<string, unknown>;
    const list = tasks.list as Record<string, unknown>[];
    const template = taskRow(tasks, PLANNED_SERIAL);
    let next = Number(tasks.nextSerial);
    for (let i = 0; i < extra; i += 1) {
      list.unshift({
        ...structuredClone(template),
        serial: next,
        what: `0x${(0x70 + i).toString(16).repeat(32)}`,
        repeatOf: null,
      });
      next += 1;
    }
    tasks.nextSerial = next;
    tasks.openCount = (tasks.openCount as number) + extra;
  });
}

describe("the strips above a project's tabs", () => {
  it("draws one strip for each planned or running task, with the two lines for a plan and who took the running one", () => {
    const numbers = sceneNumbers();
    strips(numbers);
    const open = queueOf(numbers).list.filter(
      (r) => r.state === "announced" || r.state === "taken",
    );
    const drawn = screen.getAllByTestId("planned-strip");
    expect(drawn).toHaveLength(open.length);
    expect(drawn.filter((s) => s.dataset.state === "planned")).toHaveLength(
      open.filter((r) => r.state === "announced").length,
    );
    const running = drawn.find((s) => s.dataset.state === "running");
    expect(running).toBeTruthy();
    const taken = takenRowOf(takenNumbers());
    expect(
      within(running as HTMLElement).getByTestId("planned-line-1").textContent,
    ).toMatch(
      new RegExp(
        `took a task\\. ${dollars(taken.setAside).replace(".", "\\.")} are set aside until ${timeText(taken.deadline as number).replace(".", "\\.")}\\.$`,
      ),
    );
  });

  it("is a region with one heading, and says it is play money", () => {
    strips(sceneNumbers());
    for (const strip of screen.getAllByTestId("planned-strip")) {
      expect(strip.getAttribute("aria-labelledby")).toBeTruthy();
      expect(within(strip).getAllByRole("heading")).toHaveLength(1);
      expect(within(strip).getByTestId("strip-play-money").textContent).toMatch(
        /play money/,
      );
    }
  });

  it('shows at most three, and "and 2 more" opens the Money tab', () => {
    const numbers = crowded(2);
    expect(
      queueOf(numbers).list.filter(
        (r) => r.state === "announced" || r.state === "taken",
      ).length,
    ).toBeGreaterThan(3);
    const calls = strips(numbers);
    expect(screen.getAllByTestId("planned-strip")).toHaveLength(3);
    const more = screen.getByRole("button", { name: /^and \d+ more$/ });
    fireEvent.click(more);
    expect(calls.money).toBe(1);
  });

  it("draws nothing without a queue, with no planned or running task, or with a queue that could not be read", () => {
    const none = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      tasks.list = (tasks.list as Record<string, unknown>[]).filter(
        (r) => r.state !== "announced" && r.state !== "taken",
      );
      tasks.openCount = 0;
      tasks.nextExpiry = null;
      tasks.next = null;
    });
    strips(none);
    expect(screen.queryByTestId("planned-strips")).toBeNull();
    cleanup();
    const unread = sceneNumbers();
    strips({ ...unread, tasks: "unreadable" } as ProjectNumbers);
    expect(screen.queryByTestId("planned-strips")).toBeNull();
    cleanup();
    strips({ ...unread, tasks: undefined } as ProjectNumbers);
    expect(screen.queryByTestId("planned-strips")).toBeNull();
  });

  it("says a plan cannot be taken unless the team checks in, to everyone, when the check-in ends before the notice", () => {
    const numbers = sceneNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      (content.clock as { activeUntil: number }).activeUntil =
        row.noticeEnd as number;
    });
    strips(numbers);
    const row = plannedRowOf(numbers);
    const notes = screen.getAllByTestId("task-not-takeable");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.textContent).toBe(
      `This task cannot be taken unless the team checks in before ${timeText(numbers.clock.activeUntil as number)}.`,
    );
    expect(row.state).toBe("announced");
  });

  it("marks what it says with the record's age when the record is old, and does not hide a plan that was true", () => {
    const numbers = sceneNumbers();
    const old = {
      ...numbers,
      builtAt: numbers.builtAt - 3 * 3_600,
    } as ProjectNumbers;
    strips(old);
    const ages = screen.getAllByTestId("planned-age");
    expect(ages[0]?.textContent).toBe(`as of ${timeText(old.asOf.time)}`);
    cleanup();
    const stale = {
      ...numbers,
      builtAt: numbers.builtAt - 3 * 86_400,
    } as ProjectNumbers;
    strips(stale);
    expect(screen.getAllByTestId("planned-strip").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("planned-age")[0]?.textContent).toMatch(
      /This may be out of date: the server has not refreshed this project since\.$/,
    );
  });

  it("uses the team's words and a name only for a plan that ties to its record", async () => {
    const numbers = plannedNumbers();
    const row = plannedRowOf(numbers);
    strips(numbers, {
      tasks: [planTask({ usd: Number(row.maxDollars / 1_000_000n) })],
    });
    const first = screen
      .getAllByTestId("planned-line-1")
      .find((p) => p.textContent?.includes("Translate the guide"));
    expect(first?.textContent).toContain(" to Pat for ");
    cleanup();
    strips(numbers, { tasks: [planTask({ usd: 1 })] });
    expect(
      screen
        .getAllByTestId("planned-line-1")
        .some((p) => p.textContent?.includes("Translate the guide")),
    ).toBe(false);
  });
});

describe("the Money tab's planned and running tasks", () => {
  function section(numbers: ProjectNumbers, tasks: ProjectTask[] = []) {
    records = tasks;
    wrap(
      <PlannedSection
        now={nowOf(numbers.asOf.time)}
        numbers={numbers}
        project={project}
      />,
    );
  }

  it("lists each planned or running task as a row, with the money set aside and the room left under the limit", () => {
    const numbers = sceneNumbers();
    section(numbers);
    const open = queueOf(numbers).list.filter(
      (r) => r.state === "announced" || r.state === "taken",
    );
    expect(screen.getAllByTestId("planned-row")).toHaveLength(open.length);
    expect(screen.getByRole("list")).toBeTruthy();
    const queue = queueOf(numbers);
    const room = `${queue.cap.roomBps / 100}%`;
    expect(screen.getByTestId("tasks-room").textContent).toBe(
      `Money set aside for tasks: ${dollars(numbers.money.locked)}. Room left for tasks: ${room} of the project's money for now; more from ${timeText(queue.cap.frees[0]?.at ?? 0)}.`,
    );
    expect(screen.getByTestId("planned-play-money").textContent).toMatch(
      /play money/,
    );
  });

  it("says no task is planned or running when none is, and that nothing is set aside", () => {
    const numbers = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      tasks.list = (tasks.list as Record<string, unknown>[]).filter(
        (r) => r.state !== "announced" && r.state !== "taken",
      );
      tasks.openCount = 0;
      tasks.nextExpiry = null;
      tasks.next = null;
      (tasks.cap as Record<string, unknown>).frees = [];
      (content.money as Record<string, unknown>).locked = "0";
    });
    section(numbers);
    expect(screen.getByTestId("planned-none").textContent).toBe(
      "No task is planned or running now.",
    );
    expect(screen.getByTestId("tasks-room").textContent).toMatch(
      /^No money is set aside for tasks\. Room left for tasks: \d+(\.\d+)?% of the project's money for now\.$/,
    );
  });

  it("says the list could not be read, and that the person's money is not affected, when the queue is unreadable", () => {
    const numbers = sceneNumbers();
    section({ ...numbers, tasks: "unreadable" } as ProjectNumbers);
    expect(screen.getByTestId("tasks-unreadable").textContent).toBe(
      "The task list could not be read. Your money is not affected: you can take it out any time.",
    );
  });

  it("draws nothing when the server wrote no queue", () => {
    const numbers = sceneNumbers();
    section({ ...numbers, tasks: null } as ProjectNumbers);
    expect(screen.queryByTestId("planned-section")).toBeNull();
    expect(screen.queryByTestId("tasks-unreadable")).toBeNull();
  });
});
