// The Claim sheet: the holder is always the connected account, the figure is the network's, a task paid in full or a claim
// already paid gives no press, a task that ran out and nobody settled shows the whole claim and the press works, and the
// press never sends twice or on numbers that moved.
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { wrap } from "../../../../../tests/helpers/money-harness";
import {
  CLAIMANT,
  chain,
  ENDED_SERIAL,
  notesScene,
  notesSceneHooks,
  numbers,
  RUNNING_SERIAL,
  rowOf,
  runOut,
  STAYER,
  withRow,
} from "../../../../../tests/helpers/notes-scene";
import {
  planTask,
  pointRow,
  queueOf,
  sceneAnswers,
  TASK_ID,
} from "../../../../../tests/helpers/plan-scene";
import { timeText } from "../../../money/numbers";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import type { ChainTask } from "../types";
import { dollarsPhrase } from "../words";
import { NotesCard } from "./NotesSection";

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
const confirm = () => screen.getByTestId("sheet-confirm") as HTMLButtonElement;
const named = (content: Record<string, unknown>) =>
  pointRow(content, ENDED_SERIAL, TASK_ID);

function show() {
  wrap(
    <NotesCard
      anchor
      numbers={numbers}
      project={project}
      projectKey={numbers.key}
    />,
  );
}

async function openClaim() {
  fireEvent.click(await screen.findByTestId("notes-claim"));
  return screen.findByTestId("claim-owed");
}

/** The chain says something other than the record about a row. */
function chainSays(serial: number, over: Partial<ChainTask>) {
  Object.assign(
    chain.answers,
    sceneAnswers(numbers, {
      rows: queueOf(numbers).list.map((r) =>
        r.serial === BigInt(serial) ? { ...r, ...over } : r,
      ),
    }),
  );
}

const claimOf = (serial: number, who: string) =>
  rowOf(serial).notes?.holders.find((h) => h.account === who);

describe("a claim on a task that ended", () => {
  it("says what was set aside, what came back and what is owed, and sends one call for the connected account", async () => {
    notesScene({ patch: named });
    records = [planTask({ id: TASK_ID, what: "Translate the guide" })];
    show();
    await openClaim();
    const row = rowOf(ENDED_SERIAL);
    const owed = claimOf(ENDED_SERIAL, CLAIMANT)?.claimable ?? 0n;
    expect(
      screen.getByRole("dialog").getAttribute("aria-labelledby"),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: `Claim ${dollarsPhrase(owed)} for “Translate the guide”`,
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("claim-set-aside").textContent).toBe(
      dollarsPhrase(row.setAside),
    );
    expect(screen.getByTestId("claim-returned").textContent).toBe(
      dollarsPhrase(row.returned),
    );
    expect(screen.getByTestId("claim-owed").textContent).toBe(
      dollarsPhrase(owed),
    );
    expect(screen.getByTestId("claim-words").textContent).toBe(
      `When you took out, ${dollarsPhrase(row.setAside)} were set aside for this task. It ended, and ${dollarsPhrase(row.returned)} of it came back; you are owed ${dollarsPhrase(owed)} now. The money goes to your account.`,
    );
    expect(screen.getByTestId("sheet-play-money")).toBeTruthy();
    expect(confirm().textContent).toBe(`Claim ${dollarsPhrase(owed)}`);
    // The claim is gone once it landed: the chain says so, and the list follows.
    chain.onSend = () => {
      chain.answers.noteOf = [0n];
    };
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.name).toBe("claimNote");
    expect(call?.args).toEqual([row.serial, CLAIMANT]);
    expect(chain.sent[0]?.to).toBe(numbers.contracts.treasury);
    expect(chain.sent[0]?.from).toBe(CLAIMANT);
    expect(
      await screen.findByText("Claimed. The money is in your wallet."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("claim-sheet")).toBeNull());
  });

  it("names no one but the connected account: the holder of the call is the account that sends, whoever the record lists", async () => {
    notesScene({ account: STAYER, patch: runOut });
    show();
    await openClaim();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.args[1]).toBe(STAYER);
    expect(chain.sent[0]?.from).toBe(STAYER);
  });

  it("is a task that ran out and nobody settled: the whole claim is shown and the press works", async () => {
    notesScene({ account: STAYER, patch: runOut });
    show();
    await openClaim();
    const face = claimOf(RUNNING_SERIAL, STAYER)?.face ?? 0n;
    expect(screen.getByTestId("claim-owed").textContent).toBe(
      dollarsPhrase(face),
    );
    expect(screen.getByTestId("claim-words").textContent).toMatch(
      /nobody has returned the money yet\. Claiming returns it first, and you are owed .* now\. The money goes to your account\.$/,
    );
    expect(screen.queryByTestId("claim-returned")).toBeNull();
    expect(screen.queryByTestId("claim-blocked")).toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it("gives no press once the claim is gone: it was claimed meanwhile", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    chain.answers.noteOf = [0n];
    fireEvent.click(open);
    expect((await screen.findByTestId("claim-blocked")).textContent).toBe(
      "There is nothing to claim here: the task was paid in full, or you already claimed. Nothing changed.",
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("gives no press on a task paid in full", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    chainSays(ENDED_SERIAL, { state: "paid", returned: 0n });
    fireEvent.click(open);
    expect((await screen.findByTestId("claim-blocked")).textContent).toMatch(
      /paid in full, or you already claimed/,
    );
    expect(confirm().disabled).toBe(true);
  });

  it("says a task that has not ended is not to be claimed yet, and when it ends", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    const later = Math.floor(Date.now() / 1000) + 7_200;
    chainSays(ENDED_SERIAL, {
      state: "taken",
      deadline: later,
      expiresAt: later,
    });
    fireEvent.click(open);
    expect((await screen.findByTestId("claim-blocked")).textContent).toBe(
      `This task has not ended yet, so there is nothing to claim. It ends by ${timeText(later)}.`,
    );
    expect(confirm().disabled).toBe(true);
  });

  it("does not act on a figure that is not the contract's rounding of the claim", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    const owed = claimOf(ENDED_SERIAL, CLAIMANT)?.claimable ?? 0n;
    chain.answers.claimableNote = [owed + 1n];
    fireEvent.click(open);
    expect((await screen.findByTestId("claim-blocked")).textContent).toMatch(
      /did not add up/,
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("says it could not read, and offers to try again, when the network cannot be asked", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    delete chain.answers.claimableNote;
    fireEvent.click(open);
    expect(
      (await screen.findByTestId("claim-read-failed")).textContent,
    ).toMatch(/could not be read from the network, so nothing can be sent now/);
    expect(confirm().disabled).toBe(true);
  });
});

describe("the last look and the one send", () => {
  it("looks again right before the send: a task that moved is not claimed on the old figure", async () => {
    notesScene({ patch: named });
    show();
    await openClaim();
    chainSays(ENDED_SERIAL, { returned: rowOf(ENDED_SERIAL).returned / 2n });
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("looks again right before the send: a claim paid meanwhile is not sent again", async () => {
    notesScene({ patch: named });
    show();
    await openClaim();
    chain.answers.noteOf = [0n];
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("a double press sends one call", async () => {
    notesScene({ patch: named });
    chain.holdReceipts = true;
    show();
    await openClaim();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("a send that went out but has not landed is looked for, not sent again: a claim found paid is the step that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    notesScene({ patch: named });
    chain.holdReceipts = true;
    show();
    await openClaim();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("claim-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("claim-sheet")).toBeNull());
    // It landed under another hash after all: the claim is gone. The list still shows the row it was read with, and the sheet
    // opened from it says the step landed and looks for it.
    const open = screen.getByTestId("notes-claim");
    chain.answers.noteOf = [0n];
    fireEvent.click(open);
    await screen.findByTestId("claim-set-aside");
    expect(screen.queryByTestId("claim-blocked")).toBeNull();
    expect(confirm().textContent).toBe("Look for your claim");
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() => expect(screen.queryByTestId("claim-sheet")).toBeNull());
    expect(chain.sent).toHaveLength(1);
  }, 20_000);

  it("a claim that is gone with no send of ours waiting is a block, not a landed step", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    chain.answers.noteOf = [0n];
    fireEvent.click(open);
    expect(await screen.findByTestId("claim-blocked")).toBeTruthy();
    expect(confirm().textContent).toBe(`Claim`);
  });

  it("Escape closes it and focus goes back to the press that opened it", async () => {
    notesScene({ patch: named });
    show();
    const open = await screen.findByTestId("notes-claim");
    open.focus();
    fireEvent.click(open);
    await screen.findByTestId("claim-owed");
    fireEvent.keyDown(screen.getByTestId("claim-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("claim-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("notes-claim"));
  });

  it("says in words a refusal from the network", async () => {
    notesScene({ patch: named });
    show();
    await openClaim();
    chain.refuse = "execution reverted: NothingToPay()";
    fireEvent.click(confirm());
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(/There is nothing to claim here/);
    expect(problem.textContent).not.toMatch(/NothingToPay/);
  });
});

void within;
void withRow;
