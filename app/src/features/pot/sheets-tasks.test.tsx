// The lines about tasks on the Back and Take out sheets, and the Take out button on a strip: the sheet needs only the chain's
// own quote (the record's figures are props the page already holds, never reads of the sheet's own), the planned-task line is
// said from the record's rows, and the money set aside for tasks is said as the chain counts it.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  D,
  nameTheNetwork,
  S,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
import {
  PLANNED_SERIAL,
  plannedNumbers,
  plannedRowOf,
  queueOf,
  sceneNumbers,
} from "../../../tests/helpers/plan-scene";
import { taskRow } from "../../../tests/helpers/numbers-v2-fixture";
import { timeText, type ProjectNumbers } from "../money/numbers";
import { PlannedStrips } from "../tasks/chain/holder/PlannedStrips";
import type { Project } from "../project/project-record";
import { BackCard } from "./BackCard";
import { smallDollarsText } from "../money/copy";
import { targetOf } from "./target";
import { HoldingTop } from "./HoldingTop";

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
}));

let numbers: ProjectNumbers;
let chain: PotChain;
const project = {
  coordinate: `37001:${"f".repeat(64)}:orbit`,
  author: "f".repeat(64),
  name: "Orbit",
  team: [],
} as unknown as Project;

function setup(
  over: Record<string, unknown> = {},
  held: { shares?: bigint } = { shares: 1_000n * S },
) {
  chain = installPotChain({
    account: BACKER_EVM,
    answers: { ...backerAnswers(numbers, held), ...over } as never,
  });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  numbers = sceneNumbers();
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

const dollars = (raw: bigint) =>
  raw === 1_000_000n ? "1 dollar" : `${smallDollarsText(raw)} dollars`;

describe("the Take out sheet's line about a task", () => {
  const note = 5_000_000n;
  const quote = (args: readonly unknown[]) => [
    ((args[1] as bigint) * 9_800n) / S,
    note,
    0n,
  ];

  async function open(info?: {
    /** The record's limit; null is a page with no task queue to go to. */
    dueSecs: number | null;
    claims?: () => void;
  }) {
    wrap(
      <HoldingTop
        onOpenMoney={info?.claims ?? (() => {})}
        projectName="Orbit"
        target={targetOf(numbers)}
        tasks={
          info && info.dueSecs !== null
            ? { limits: { dueSecs: info.dueSecs } }
            : null
        }
      />,
    );
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    return screen.findByTestId("takeout-note");
  }

  it("says what you get now and what you could be owed later, for how long, from the chain's quote alone, with a way to the claims", async () => {
    setup({ quoteTakeOut: quote });
    const claims = vi.fn();
    const line = await open({ dueSecs: 14 * 86_400, claims });
    const cash = screen.getByTestId("takeout-cash").textContent;
    expect(cash).toBe("9.80 dollars");
    expect(line.textContent).toBe(
      `Part of the project's money is set aside for a task, for up to 14 days. You get ${cash} now, and up to ${dollars(note)} more if the task is not paid in full.`,
    );
    expect(line.textContent).not.toMatch(/note/i);
    fireEvent.click(screen.getByTestId("takeout-where-to-claim"));
    expect(claims).toHaveBeenCalledTimes(1);
    // The sheet closed on the way.
    await waitFor(() =>
      expect(screen.queryByTestId("takeout-sheet")).toBeNull(),
    );
  });

  it("is the shorter sentence when the page has no limit, and has no link when the page cannot go to the claims", async () => {
    setup({ quoteTakeOut: quote });
    const line = await open({ dueSecs: null });
    expect(line.textContent).toMatch(
      /^Part of the project's money is set aside for a task\. You get 9\.80 dollars now, and up to 5 dollars more if the task is not paid in full\.$/,
    );
    expect(screen.queryByTestId("takeout-where-to-claim")).toBeNull();
  });

  it("says nothing about a task when the quote has no note", async () => {
    setup();
    wrap(
      <HoldingTop
        onOpenMoney={() => {}}
        projectName="Orbit"
        target={targetOf(numbers)}
        tasks={{ limits: { dueSecs: 100 } }}
      />,
    );
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    expect(screen.queryByTestId("takeout-note")).toBeNull();
  });

  it("presses with the record hung, the book unreadable and the queue unreadable: until the press it reads the quote and nothing about tasks", async () => {
    // No answer for any task view: a read of one would fail the sheet.
    setup({ quoteTakeOut: quote });
    numbers = { ...numbers, tasks: "unreadable" } as ProjectNumbers;
    await open(undefined);
    const tasksViews = [
      "tasks",
      "taskOf",
      "openSerials",
      "noteOf",
      "claimableNote",
      "nextSerial",
      "takeRoomBps",
      "activeEnd",
    ];
    const before = new Set(chain.reads.map((r) => r.name));
    for (const name of tasksViews) expect(before.has(name)).toBe(false);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    // After it landed the app may look (in the background, best effort) for the tasks it left money owed on: only the book's
    // address, never a view of a task.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = new Set(chain.reads.map((r) => r.name));
    for (const name of tasksViews.filter((n) => n !== "tasks"))
      expect(after.has(name)).toBe(false);
  });
});

describe("the Back sheet's lines about tasks", () => {
  async function openBack() {
    wrap(
      <BackCard
        now={numbers.asOf.time + 100}
        numbers={numbers}
        projectName="Orbit"
      />,
    );
    fireEvent.change(await screen.findByLabelText("How many dollars?"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("backing-review"));
    await screen.findByTestId("back-pay");
  }

  it("says what money set aside for tasks means for the price, and none without", async () => {
    setup({
      quoteBack: (args: readonly unknown[]) => {
        const amount = args[0] as bigint;
        return [(amount * 100n * S) / D, (amount * 98n) / 100n, 40n * D, 0n];
      },
    });
    await openBack();
    expect(screen.getByTestId("back-locked").textContent).toBe(
      "Money set aside for tasks: 40 dollars. You pay for it at full value now. If the task is paid, that cost is shared by everyone who holds; if it is not, the money comes back to the project.",
    );
    cleanup();
    setup();
    await openBack();
    expect(screen.getByTestId("back-locked").textContent).toBe(
      "Money set aside for tasks: none.",
    );
  });

  it("says a plan is coming, from the record's rows, without a read of its own", async () => {
    numbers = plannedNumbers();
    nameTheNetwork(numbers);
    setup();
    await openBack();
    const queue = queueOf(numbers);
    const rows = queue.list.filter(
      (r) => r.state === "announced" && r.expiresAt > numbers.asOf.time,
    );
    const total = rows.reduce((sum, r) => sum + r.maxDollars, 0n);
    const first = Math.min(...rows.map((r) => r.noticeEnd));
    expect(screen.getByTestId("back-planned").textContent).toBe(
      `The team plans to pay up to ${dollars(total)} in all for ${rows.length} tasks, from ${timeText(first)}. You can take your money out any time.`,
    );
    expect(chain.reads.some((r) => r.name === "taskOf")).toBe(false);
  });

  it("says a plan that can be taken now can be taken now, with no date", async () => {
    numbers = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      for (const r of tasks.list as Record<string, unknown>[])
        if (r.state === "announced")
          r.noticeEnd = (content.asOf as { time: number }).time - 60;
    });
    nameTheNetwork(numbers);
    setup();
    await openBack();
    const rows = queueOf(numbers).list.filter((r) => r.state === "announced");
    const total = rows.reduce((sum, r) => sum + r.maxDollars, 0n);
    expect(screen.getByTestId("back-planned").textContent).toBe(
      `The team plans to pay up to ${dollars(total)} in all for ${rows.length} tasks, and it can be taken now. You can take your money out any time.`,
    );
  });

  it("says it for one task in the singular, and says nothing without a plan or without a queue", async () => {
    numbers = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      tasks.list = (tasks.list as Record<string, unknown>[]).filter(
        (r) => r.state !== "announced" || r.serial === PLANNED_SERIAL,
      );
      tasks.openCount = (tasks.list as { state: string }[]).filter(
        (r) => r.state === "announced" || r.state === "taken",
      ).length;
    });
    nameTheNetwork(numbers);
    setup();
    await openBack();
    const row = plannedRowOf(numbers);
    expect(screen.getByTestId("back-planned").textContent).toBe(
      `The team plans to pay up to ${dollars(row.maxDollars)} for a task, from ${timeText(row.noticeEnd)}. You can take your money out any time.`,
    );
    cleanup();
    numbers = { ...numbers, tasks: null } as ProjectNumbers;
    setup();
    await openBack();
    expect(screen.queryByTestId("back-planned")).toBeNull();
  });
});

describe("Take out on a strip", () => {
  function strips(address: string | null) {
    wrap(
      <PlannedStrips
        address={address}
        numbers={numbers}
        onOpenMoney={() => {}}
        project={project}
      />,
    );
  }

  it("is drawn for a holder the record lists, named for its date, and opens the same sheet", async () => {
    setup();
    strips(BACKER_EVM);
    const waiting = queueOf(numbers).list.find(
      (r) => r.state === "announced" && r.noticeEnd > numbers.asOf.time,
    );
    const button = await screen.findByRole("button", {
      name: `Take out before ${timeText(waiting?.noticeEnd ?? 0)}`,
    });
    // Only a plan has the button: the task in progress has none.
    const running = screen
      .getAllByTestId("planned-strip")
      .filter((strip) => strip.dataset.state === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const strip of running)
      expect(strip.querySelector("[data-testid=strip-take-out]")).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByTestId("takeout-sheet")).not.toBeNull();
    expect((await screen.findByTestId("takeout-cash")).textContent).toBe(
      "9.80 dollars",
    );
  });

  it("is not drawn for someone the record does not list, or with no wallet", async () => {
    setup();
    strips(STRANGER_EVM);
    await screen.findAllByTestId("planned-strip");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("strip-take-out")).toBeNull();
    cleanup();
    strips(null);
    await screen.findAllByTestId("planned-strip");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("strip-take-out")).toBeNull();
  });

  it("is named for its date only while the notice runs: once a plan can be taken the money may move now, so it says now", async () => {
    numbers = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      for (const r of tasks.list as Record<string, unknown>[])
        if (r.state === "announced")
          r.noticeEnd = (content.asOf as { time: number }).time - 60;
      void taskRow;
    });
    nameTheNetwork(numbers);
    setup();
    strips(BACKER_EVM);
    expect(
      await screen.findByRole("button", { name: "Take out now" }),
    ).not.toBeNull();
  });
});
