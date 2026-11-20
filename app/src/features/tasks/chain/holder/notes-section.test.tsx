// "Money you can claim": the list a person is owed from tasks they took out of while money was set aside. It is made from the
// signed record's rows (a hint), what this browser remembers and a look back the person asks for; every figure on it is the
// network's, for the connected account, and a person with no Shares sees it.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../../../tests/helpers/axe-dom";
import { wrap } from "../../../../../tests/helpers/money-harness";
import {
  CLAIMANT,
  chain,
  ENDED_SERIAL,
  mintedLog,
  notesScene,
  notesSceneHooks,
  numbers,
  RUNNING_SERIAL,
  rowOf,
  runOut,
  serveLogs,
  STAYER,
  withRow,
} from "../../../../../tests/helpers/notes-scene";
import {
  planTask,
  pointRow,
  TASK_ID,
} from "../../../../../tests/helpers/plan-scene";
import { dayText } from "../../../money/numbers";
import {
  ownNoteSerials,
  rememberNotes,
  rememberStep,
} from "../../../pot/own-history";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import type { ChainTask } from "../types";
import { dollarsPhrase } from "../words";
import { goToClaims } from "./claims-anchor";
import { NotesCard } from "./NotesSection";
import { LOOK_FIRST } from "./notes-words";

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

notesSceneHooks();

const project = {
  coordinate: `37001:${"f".repeat(64)}:orbit`,
  author: "f".repeat(64),
  name: "Orbit",
  team: [],
} as unknown as Project;

function show(
  over: { staged?: boolean; heading?: string; anchor?: boolean } = {},
) {
  wrap(
    <NotesCard
      anchor={over.anchor ?? true}
      heading={over.heading}
      numbers={numbers}
      project={project}
      projectKey={numbers.key}
      staged={over.staged}
    />,
  );
}

/** The example's ended task, named by the team's own record so the list can say what it was. */
const named = (content: Record<string, unknown>) =>
  pointRow(content, ENDED_SERIAL, TASK_ID);

const claimOf = (row: ChainTask, who = CLAIMANT) =>
  row.notes?.holders.find((h) => h.account === who);

/** A second task that ended with a claim waiting for the account, which the record does not list. */
function extraRow(serial: bigint, over: Partial<ChainTask> = {}): ChainTask {
  const base = rowOf(ENDED_SERIAL);
  const mine = claimOf(base);
  return {
    ...base,
    serial,
    what: `0x${"2".repeat(64)}`,
    notes: {
      faceTotal: mine?.face ?? 0n,
      holders: mine ? [{ ...mine }] : [],
      holdersCut: false,
    },
    ...over,
  };
}

const getLogsCalls = () => {
  const calls: unknown[] = [];
  const eth = (
    window as unknown as {
      ethereum: { request: (a: unknown) => Promise<unknown> };
    }
  ).ethereum;
  const original = eth.request.bind(eth);
  eth.request = async (args: unknown) => {
    if ((args as { method: string }).method === "eth_getLogs") calls.push(args);
    return original(args);
  };
  return calls;
};

describe("the list", () => {
  it("shows a task that ended with money waiting: what it was, what was set aside, what can be claimed now, and the press", async () => {
    notesScene({ patch: named });
    records = [planTask({ id: TASK_ID, what: "Translate the guide" })];
    show();
    const row = await screen.findByTestId("notes-row");
    const ended = rowOf(ENDED_SERIAL);
    const claimable = claimOf(ended)?.claimable ?? 0n;
    expect(within(row).getByText(/you took out while/).textContent).toBe(
      `“Translate the guide”: you took out while ${dollarsPhrase(ended.setAside)} were set aside for it. The task is ended.`,
    );
    expect(within(row).getByTestId("notes-row-line").textContent).toBe(
      `You can claim ${dollarsPhrase(claimable)} now.`,
    );
    expect(
      within(row).getByRole("button", {
        name: `Claim ${dollarsPhrase(claimable)}`,
      }),
    ).toBeTruthy();
  });

  it("is for a person with no Shares: nothing about Shares is read", async () => {
    notesScene({ patch: named });
    show();
    await screen.findByTestId("notes-row");
    expect(chain.reads.some((r) => r.name === "balanceOf")).toBe(false);
  });

  it("says a task still running holds a claim up to a face, with no press", async () => {
    notesScene({ account: STAYER });
    show();
    const row = await screen.findByTestId("notes-row");
    const face = claimOf(rowOf(RUNNING_SERIAL), STAYER)?.face ?? 0n;
    expect(within(row).getByText(/you took out while/).textContent).toMatch(
      /The task is still running\.$/,
    );
    expect(within(row).getByTestId("notes-row-line").textContent).toBe(
      `You will be able to claim up to ${dollarsPhrase(face)} if it is not paid.`,
    );
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("says a task that ran out and nobody returned pays the whole claim now, and that claiming returns the money first", async () => {
    notesScene({ account: STAYER, patch: runOut });
    show();
    const row = await screen.findByTestId("notes-row");
    const face = claimOf(rowOf(RUNNING_SERIAL), STAYER)?.face ?? 0n;
    expect(within(row).getByTestId("notes-row-line").textContent).toBe(
      `This task ran out. You can claim ${dollarsPhrase(face)} now; claiming returns the money first.`,
    );
    expect(
      within(row).getByRole("button", { name: `Claim ${dollarsPhrase(face)}` }),
    ).toBeTruthy();
  });

  it("says a task paid in full leaves nothing to claim, and has no press", async () => {
    notesScene({
      rows: withRow(ENDED_SERIAL, {
        state: "paid",
        returned: 0n,
        pay: rowOf(ENDED_SERIAL).setAside,
      }),
    });
    show();
    const row = await screen.findByTestId("notes-row");
    expect(within(row).getByTestId("notes-row-line").textContent).toBe(
      "It was paid in full, so there is nothing to claim.",
    );
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("takes the figure from the network, not from the record: what came back is what the network says", async () => {
    const ended = () => rowOf(ENDED_SERIAL);
    notesScene({
      rows: (queue) =>
        withRow(ENDED_SERIAL, {
          returned:
            (queue.list.find((r) => r.serial === BigInt(ENDED_SERIAL))
              ?.returned ?? 0n) / 2n,
        })(queue),
    });
    show();
    const row = await screen.findByTestId("notes-row");
    const face = claimOf(ended())?.face ?? 0n;
    const half = ended().returned / 2n;
    const owed = (face * half) / ended().setAside;
    expect(owed).not.toBe(claimOf(ended())?.claimable);
    expect(within(row).getByTestId("notes-row-line").textContent).toBe(
      `You can claim ${dollarsPhrase(owed)} now.`,
    );
  });

  it("drops a task the network says holds nothing for the account (claimed already)", async () => {
    notesScene({ account: "0x00000000000000000000000000000000000000ab" });
    show();
    expect((await screen.findByTestId("notes-none")).textContent).toBe(
      "Nothing is waiting for you to claim.",
    );
    expect(screen.queryByTestId("notes-row")).toBeNull();
  });

  it("never says nothing is waiting when the server's list is cut, and says why", async () => {
    notesScene({
      account: "0x00000000000000000000000000000000000000ab",
      patch: (content) => {
        (content.tasks as { truncated: boolean }).truncated = true;
      },
    });
    show();
    expect((await screen.findByTestId("notes-none")).textContent).toMatch(
      /the server's list is cut, so an older one may be missing\. Press “Look for money I can claim” to find it\.$/,
    );
  });

  it("says it could not read, offers to try again, and never says nothing is waiting, when the network cannot be asked", async () => {
    notesScene();
    delete chain.answers.noteOf;
    show();
    expect(
      (await screen.findByTestId("notes-read-failed")).textContent,
    ).toMatch(
      /could not be read from the network just now\. Your money is not affected\./,
    );
    expect(screen.queryByTestId("notes-none")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("is behind the wallet gate: on another network there is no list", async () => {
    notesScene();
    chain.chain = "0x1";
    show();
    expect(await screen.findByTestId("pot-wrong-network")).toBeTruthy();
    expect(screen.queryByTestId("notes-section")).toBeNull();
  });

  it("says it is play money, and that what is owed never runs out", async () => {
    notesScene();
    show();
    await screen.findByTestId("notes-row");
    expect(screen.getByTestId("notes-play-money").textContent).toMatch(
      /play money/,
    );
    expect(screen.getByTestId("notes-never-expire").textContent).toMatch(
      /never runs out/,
    );
    // It names the button that finds older ones, by the button's own words.
    expect(screen.getByTestId("notes-never-expire").textContent).toContain(
      `“${LOOK_FIRST}”`,
    );
    expect(screen.getByTestId("notes-look").textContent).toBe(LOOK_FIRST);
  });

  it("is a list with a name, under one heading that can take focus", async () => {
    notesScene({ patch: named });
    show();
    await screen.findByTestId("notes-row");
    const list = screen.getByRole("list");
    for (const item of within(list).getAllByRole("listitem"))
      expect(item.getAttribute("aria-labelledby")).toBeTruthy();
    const heading = screen.getByRole("heading", {
      name: "Money you can claim",
    });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(await seriousViolations()).toEqual([]);
    // "Where you claim it" lands on it.
    goToClaims();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe("what this browser remembers", () => {
  it("finds a task the record does not list, from the person's own history, with no look back", async () => {
    notesScene({ rows: (queue) => [...queue.list, extraRow(20n)] });
    const tx = `0x${"ab".repeat(32)}`;
    rememberStep(CLAIMANT, {
      kind: "take-out",
      project: numbers.key,
      at: 1,
      dollars: "1",
      shares: "1",
      txHash: tx,
    });
    rememberNotes(CLAIMANT, tx, [20n]);
    expect(ownNoteSerials(CLAIMANT, numbers.key)).toEqual([20n]);
    const logs = getLogsCalls();
    show();
    await waitFor(() =>
      expect(screen.getAllByTestId("notes-row")).toHaveLength(2),
    );
    expect(logs).toEqual([]);
  });
});

describe("the look back", () => {
  it("walks newest first, finds a task nothing else listed, and says it looked all the way back", async () => {
    const book = (() => numbers)();
    void book;
    notesScene({ rows: (queue) => [...queue.list, extraRow(30n)] });
    const asked = serveLogs(
      [
        mintedLog({
          book: queueBook(),
          serial: 30n,
          holder: CLAIMANT,
          block: 600,
        }),
      ],
      { head: 1_000 },
    );
    show();
    await screen.findByTestId("notes-row");
    expect(screen.getAllByTestId("notes-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("notes-look"));
    await waitFor(() =>
      expect(screen.getAllByTestId("notes-row")).toHaveLength(2),
    );
    expect(screen.getByTestId("notes-look-words").textContent).toBe(
      "Looked back to the start of this project's tasks.",
    );
    // Newest first: the first range asked ends at the newest block.
    expect(asked[0]?.to).toBe(1_000);
  });

  it("says nothing was found, back to the start, only when the look reached the start", async () => {
    notesScene();
    serveLogs([], { head: 1_000 });
    show();
    await screen.findByTestId("notes-row");
    fireEvent.click(screen.getByTestId("notes-look"));
    await waitFor(() =>
      expect(screen.getByTestId("notes-look-words").textContent).toBe(
        "Nothing found back to the start of this project's tasks.",
      ),
    );
  });

  it("says where it got to when it stopped early, goes on from there, and never says none for an unfinished look", async () => {
    notesScene({ rows: (queue) => [...queue.list, extraRow(30n)] });
    const asked = serveLogs(
      [
        mintedLog({
          book: queueBook(),
          serial: 30n,
          holder: CLAIMANT,
          block: 10_000,
        }),
      ],
      { head: 250_000 },
    );
    show();
    await screen.findByTestId("notes-row");
    fireEvent.click(screen.getByTestId("notes-look"));
    await waitFor(() =>
      expect(screen.getByTestId("notes-look-words").textContent).toMatch(
        /^Looked back to .*\. Look further back\.$/,
      ),
    );
    const words = screen.getByTestId("notes-look-words").textContent ?? "";
    expect(words).toContain(dayText(chain.blockTime));
    expect(words).not.toMatch(/Nothing found/);
    expect(screen.getByTestId("notes-look").textContent).toBe(
      "Look further back",
    );
    const firstRun = asked.length;
    expect(screen.getAllByTestId("notes-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("notes-look"));
    await waitFor(() =>
      expect(screen.getAllByTestId("notes-row")).toHaveLength(2),
    );
    // The second press went on below where the first stopped, not from the start again.
    const lowestFirst = Math.min(
      ...asked.slice(0, firstRun).map((a) => a.from),
    );
    expect(asked[firstRun]?.to).toBe(lowestFirst - 1);
    expect(screen.getByTestId("notes-look-words").textContent).toBe(
      "Looked back to the start of this project's tasks.",
    );
  });

  it("says it could not look, and not that nothing was found, when the node refuses even a small range", async () => {
    notesScene();
    serveLogs([], { head: 1_000, refuseAll: true });
    show();
    await screen.findByTestId("notes-row");
    fireEvent.click(screen.getByTestId("notes-look"));
    await waitFor(() =>
      expect(screen.getByTestId("notes-look-words").textContent).toBe(
        "Could not look just now. Try again in a moment.",
      ),
    );
    expect(screen.getByTestId("notes-look-words").textContent).not.toMatch(
      /Nothing found/,
    );
  });
});

describe("a look the node gives up on part of the way back", () => {
  it("keeps what it found before it gave up, and says it could not look, never that nothing was found", async () => {
    notesScene({ rows: (queue) => [...queue.list, extraRow(30n)] });
    serveLogs(
      [
        mintedLog({
          book: queueBook(),
          serial: 30n,
          holder: CLAIMANT,
          block: 950,
        }),
      ],
      { head: 1_000, refuseBelow: 500 },
    );
    show();
    await screen.findByTestId("notes-row");
    expect(screen.getAllByTestId("notes-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("notes-look"));
    await waitFor(() =>
      expect(screen.getByTestId("notes-look-words").textContent).toBe(
        "Could not look just now. Try again in a moment.",
      ),
    );
    // What it found on the way is on the list.
    await waitFor(() =>
      expect(screen.getAllByTestId("notes-row")).toHaveLength(2),
    );
  });
});

describe("on You, where the first ten are shown", () => {
  it("shows ten, then the rest when asked", async () => {
    const extras = Array.from({ length: 12 }, (_, i) => 100n + BigInt(i));
    notesScene({
      rows: (queue) => [...queue.list, ...extras.map((s) => extraRow(s))],
    });
    const tx = `0x${"cd".repeat(32)}`;
    rememberStep(CLAIMANT, {
      kind: "take-out",
      project: numbers.key,
      at: 1,
      dollars: "1",
      shares: "1",
      txHash: tx,
    });
    rememberNotes(CLAIMANT, tx, extras);
    show({ staged: true, heading: "Orbit", anchor: false });
    await waitFor(() =>
      expect(screen.getAllByTestId("notes-row")).toHaveLength(10),
    );
    expect(screen.getByRole("heading", { name: "Orbit" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("notes-show-more"));
    // Twelve of the person's own and the example's ended task: thirteen, all there is.
    await waitFor(() =>
      expect(screen.getAllByTestId("notes-row")).toHaveLength(13),
    );
    expect(screen.queryByTestId("notes-show-more")).toBeNull();
  });
});

function queueBook(): string {
  const queue = numbers.tasks;
  if (typeof queue !== "object" || queue === null) throw new Error("no queue");
  return queue.book;
}

void cleanup;
