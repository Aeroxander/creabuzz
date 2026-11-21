// A list of task cards repeats the same presses ("Take this task", "Hand in the work", "Pay for the work", ...). Each press names
// its task as well, after its own words, so a screen reader that lists the buttons of the page tells them apart, and the name
// always contains the words on the button.
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import {
  FOUNDER_KEY,
  planTask,
  sceneNumbers,
  WORKER,
} from "../../../tests/helpers/plan-scene";
import type { Project } from "../project/project-record";
import { TasksTab } from "./TasksTab";
import { pressName } from "./tasks-copy";
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

afterEach(() => {
  cleanup();
  pubkey = FOUNDER_KEY;
  records = [];
});

/** What a screen reader says of a button: its own name when it has one, else its words. */
const nameOf = (button: HTMLElement) =>
  (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();

describe("the names of the presses on task cards", () => {
  it("builds the name from the press's words and then the task, cut at a sentence a person can bear", () => {
    expect(pressName("Take this task", "Draw the cover")).toBe(
      "Take this task: Draw the cover",
    );
    expect(pressName("Take this task", "  Draw \n the   cover ")).toBe(
      "Take this task: Draw the cover",
    );
    expect(pressName("Take this task", null)).toBe("Take this task");
    expect(pressName("Take this task", "")).toBe("Take this task");
    const long = pressName("Hand in the work", "x".repeat(200));
    expect(long.startsWith("Hand in the work: ")).toBe(true);
    expect(long.length).toBeLessThanOrEqual("Hand in the work: ".length + 60);
  });

  it("two cards' same-worded presses have different names, and each name holds the words on the button", () => {
    // Two tasks nobody has taken (each offers "Take this task") and two the person is working on (each offers "Hand in the work").
    pubkey = WORKER;
    const numbers = sceneNumbers();
    const open = { state: "open", worker: null, payTo: null } as const;
    records = [
      planTask({ id: "6".repeat(64), what: "Draw the cover", ...open }),
      planTask({ id: "5".repeat(64), what: "Write the thanks", ...open }),
      planTask({ id: "4".repeat(64), what: "Fix the build" }),
      planTask({ id: "3".repeat(64), what: "Pack the boxes" }),
    ];
    wrap(
      <TasksTab
        address={null}
        numbers={numbers}
        profiles={undefined}
        project={project}
      />,
    );
    const buttons = screen.getAllByRole("button");
    const names = buttons.map(nameOf);
    expect(names.length).toBeGreaterThan(3);
    // No two buttons of the tab share a name unless they are the tab's own (not on a task card).
    const onCards = buttons.filter((b) => b.closest("article"));
    const cardNames = onCards.map(nameOf);
    expect(new Set(cardNames).size).toBe(cardNames.length);
    for (const b of onCards) {
      const label = b.getAttribute("aria-label");
      if (label)
        expect(
          (b.textContent ?? "").trim().length === 0 ||
            label.startsWith((b.textContent ?? "").trim()),
        ).toBe(true);
    }
  });
});
