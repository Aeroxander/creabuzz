// The sentences more than one screen says: a record that is missing or old, a planned task in two lines, a task's own words
// kept plain, why a plan does not tie, and the four sentences of a Pair. Each is plain: no code, name or hex.
import { describe, expect, it } from "vitest";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import { dayText, dollarsText, timeText } from "../../money/numbers";
import { phaseOf } from "./state";
import type { Phase } from "./state";
import type { ChainTask, ChainTasks } from "./types";
import {
  acceptTaskWords,
  ageNote,
  ageNoteOf,
  announceTaskWords,
  asOfWords,
  atMostNowLine,
  cancelTaskWords,
  DATE_COUNTS_FROM_CONFIRM,
  changedWhileLooking,
  dollarsPhrase,
  endedLine,
  NOT_RUNNER,
  notHoldingMoney,
  OWN_WORK,
  percentOfBps,
  phaseWord,
  plannedLines,
  queueLine,
  quotedWhat,
  rejectTaskWords,
  TASKS_NOT_TOLD,
  theTaskWords,
  TASKS_UNREADABLE,
  tasksStaleWords,
  tieReason,
  UNKNOWN_TASK_WORDS,
  WORDS_MAX,
} from "./words";

const example = parsedExample();
const queue = example.tasks as ChainTasks;
const row = (state: ChainTask["state"]) =>
  queue.list.find((r) => r.state === state) as ChainTask;

describe("amounts and the team's own words", () => {
  it("one dollar is a dollar; the rest are dollars, with cents when there are some", () => {
    expect(dollarsPhrase(1_000_000n)).toBe("1 dollar");
    expect(dollarsPhrase(2_000_000n)).toBe("2 dollars");
    expect(dollarsPhrase(25_500_000n)).toBe("25.50 dollars");
    expect(dollarsPhrase(430_000n)).toBe("0.43 dollars");
  });

  it("a share of the project's money as a percent", () => {
    expect(percentOfBps(100)).toBe("1%");
    expect(percentOfBps(495)).toBe("4.95%");
    expect(percentOfBps(1)).toBe("0.01%");
    expect(percentOfBps(10)).toBe("0.1%");
    expect(percentOfBps(500)).toBe("5%");
  });

  it("a task's words go in quotes as a plain text node, cut and cleaned", () => {
    expect(quotedWhat("Translate the guide")).toBe("“Translate the guide”");
    expect(quotedWhat(null)).toBe("a task");
    expect(quotedWhat("   ")).toBe("a task");
    // a quote inside cannot close the sentence early
    expect(quotedWhat('say "hello"')).toBe("“say 'hello'”");
    // markup is only text, direction marks and line breaks are gone
    expect(quotedWhat("<b>x</b>‮gnp.exe\n\tnext")).toBe(
      "“<b>x</b> gnp.exe next”",
    );
    const long = quotedWhat("x".repeat(10_000));
    expect(long.length).toBe(WORDS_MAX + 2);
    expect(long.endsWith("…”")).toBe(true);
  });
});

describe("a record that is missing, unreadable or old (1.6)", () => {
  it("says one plain line when the queue is missing or unreadable, and nothing when it reads", () => {
    expect(queueLine(undefined)).toBe(TASKS_NOT_TOLD);
    expect(queueLine(null)).toBe(TASKS_NOT_TOLD);
    expect(queueLine("unreadable")).toBe(TASKS_UNREADABLE);
    expect(queueLine(queue)).toBeNull();
    expect(TASKS_NOT_TOLD).toBe(
      "This server has not told us about this project's tasks yet.",
    );
    expect(TASKS_UNREADABLE).toBe(
      "The task list could not be read. Your money is not affected: you can take it out any time.",
    );
  });

  it("an old record says 'as of', and over a day says it may be out of date", () => {
    const built = example.builtAt;
    expect(ageNoteOf(example, built + 60)).toBeNull();
    expect(
      ageNoteOf(example, built + 3 * example.refreshEverySecs + 60),
    ).toBeNull();
    expect(ageNoteOf(example, built + 3 * example.refreshEverySecs + 61)).toBe(
      asOfWords(example.asOf.time),
    );
    const stale = ageNoteOf(example, built + 86_401);
    expect(stale).toContain(`as of ${dayText(example.asOf.time)}`);
    expect(stale).toContain(
      "This may be out of date: the server has not refreshed this project since.",
    );
    expect(ageNote({ level: "fresh", ageSecs: 0 }, 5)).toBeNull();
  });

  it("the Tasks tab line for a record over a day old says money is not affected", () => {
    expect(tasksStaleWords(example.asOf.time)).toBe(
      `We have not been able to refresh this project's tasks since ${dayText(example.asOf.time)}. Your money is not affected: you can take it out any time.`,
    );
  });
});

describe("a planned task in two lines, for everyone", () => {
  const max = 40_000_000n;
  it("before it can be taken: who, how much, which task, from when, and that taking out first is open", () => {
    const [first, second] = plannedLines({
      max,
      name: "Anna",
      what: "Translate the guide",
      date: 1_800_000_000,
      open: false,
    });
    expect(first).toBe(
      `The team plans to pay up to 40 dollars to Anna for “Translate the guide”, from ${timeText(1_800_000_000)}.`,
    );
    expect(second).toBe(
      "You can take your money out before then. 40 dollars is the most; it can be less if people take out first.",
    );
  });
  it("with no name and no tie to a record it says whoever takes it and a task", () => {
    const [first] = plannedLines({
      max,
      name: null,
      what: null,
      date: 1_800_000_000,
      open: false,
    });
    expect(first).toContain("to whoever takes it for a task,");
  });
  it("once it can be taken, the first line says until when and the second says leaving works any day", () => {
    const base = { max, name: "Anna", what: "Guide", date: 1_800_000_000 };
    const shut = plannedLines({ ...base, open: false });
    const open = plannedLines({ ...base, open: true });
    expect(open[0]).toContain(
      `It can be taken until ${timeText(1_800_000_000)}.`,
    );
    expect(shut[1]).toMatch(/^You can take your money out before then\./);
    expect(open[1]).toMatch(/^You can take your money out any time\./);
  });
  it("under it, what would be set aside today", () => {
    expect(atMostNowLine(63_750_604n)).toBe(
      "63.75 dollars would be set aside today (a share of the project's money).",
    );
  });
});

describe("a task that was taken or ended, in one line", () => {
  const now = example.asOf.time;
  const line = (
    state: ChainTask["state"],
    over: Partial<ChainTask> = {},
    name: string | null = "Pat",
  ) => {
    const task = { ...row(state), ...over };
    return endedLine({
      task,
      phase: phaseOf(task, now),
      name,
      what: "Translate the guide",
    });
  };
  it("taken says who and what is set aside until when", () => {
    const task = row("taken");
    expect(line("taken")).toBe(
      `Pat took “Translate the guide”. ${dollarsText(task.setAside)} dollars are set aside until ${timeText(task.deadline ?? 0)}.`,
    );
  });
  it("paid in full, paid in part, sent back, ran out, withdrawn, lapsed", () => {
    const paid = row("paid");
    expect(line("paid")).toBe(
      `“Translate the guide” was paid ${dollarsText(paid.pay)} dollars of the ${dollarsText(paid.setAside)} dollars set aside; the rest went back.`,
    );
    expect(line("paid", { pay: paid.setAside, returned: 0n })).toBe(
      `“Translate the guide” was paid ${dollarsText(paid.setAside)} dollars.`,
    );
    expect(line("rejected")).toBe(
      "“Translate the guide” was sent back. Nothing was paid; the money went back to the project.",
    );
    expect(line("returned")).toBe(
      "“Translate the guide” ran out. Nothing was paid; the money went back.",
    );
    expect(line("cancelled")).toBe(
      "The plan for “Translate the guide” was withdrawn.",
    );
    expect(line("lapsed")).toBe(
      "Nobody took “Translate the guide” in time, so it lapsed. Nothing moved.",
    );
  });
  it("a taken task past its deadline reads 'ran out', not 'set aside until' a date that has passed", () => {
    const task = row("taken");
    const text = endedLine({
      task,
      phase: phaseOf(task, (task.deadline ?? 0) + 1),
      name: "Pat",
      what: "Guide",
    });
    expect(text).toBe(
      "“Guide” ran out. Nothing was paid; the money went back.",
    );
  });
  it("a task that does not tie is 'a task', never the record's words", () => {
    const task = row("rejected");
    expect(
      endedLine({ task, phase: "sent-back", name: null, what: null }),
    ).toBe(
      "a task was sent back. Nothing was paid; the money went back to the project.",
    );
  });
});

describe("what a task is doing, in a few words, for a sentence about a change", () => {
  const phases: Phase[] = [
    "notice",
    "open",
    "missed",
    "working",
    "overdue",
    "paid",
    "sent-back",
    "ran-out",
    "withdrawn",
    "lapsed",
    "wound-down",
  ];
  it("every phase has words", () => {
    for (const phase of phases)
      expect(phaseWord(phase).length).toBeGreaterThan(3);
  });
  it("a task that changed under a sheet says what it is now and that nothing was sent", () => {
    expect(changedWhileLooking("paid")).toBe(
      "This task changed while you were looking: it is now already paid. Nothing was sent. Close this and open it again.",
    );
    expect(notHoldingMoney("withdrawn")).toBe(
      "This task is not holding money: withdrawn.",
    );
  });
  it("each tie failure has a reason that fits inside the sentence", () => {
    for (const why of [
      "no-record",
      "what",
      "closed",
      "already-paid",
      "amount",
      "payee",
      "taker",
      "repeat",
      "worker-left",
      "not-taken",
    ] as const)
      expect(tieReason(why)).toMatch(/^[a-z]/);
  });
  it("the step 1 refusals are the ones the Tasks tab already says", () => {
    expect(OWN_WORK).toMatch(/done by you or by an agent you run/);
    expect(NOT_RUNNER).toMatch(/Only the wallet that runs this project/);
  });
});

describe("the four sentences a Pair's second signer reads (4.7), word for word", () => {
  const anna = "Anna (0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc)";
  it("plan a task", () => {
    expect(
      announceTaskWords({
        max: 40_000_000n,
        who: anna,
        shareBps: 110,
        notice: "14 days 12 hours",
        from: 1_800_000_000,
        window: "7 days",
        due: "14 days",
      }),
    ).toBe(
      `Plan a task: pay up to 40 dollars to ${anna}, at most 1.1% of the project's money. Holders get 14 days 12 hours notice, so it can be taken from ${timeText(1_800_000_000)}; if nobody takes it within 7 days it lapses; once taken it is due 14 days later.`,
    );
    expect(
      announceTaskWords({
        max: 1_000_000n,
        who: null,
        shareBps: 1,
        notice: "1 hour",
        from: 5,
        window: "1 hour",
        due: "2 hours",
      }),
    ).toContain(
      "pay up to 1 dollar to whoever takes it first, at most 0.01% of the project's money",
    );
  });
  it("pay, send back, withdraw", () => {
    expect(
      acceptTaskWords({
        pay: 30_000_000n,
        setAside: 40_000_000n,
        serial: 3n,
        who: anna,
      }),
    ).toBe(
      `Pay 30 dollars of the 40 dollars set aside for task 3 to ${anna}. What is left goes back to the project and to those who took out while it was set aside.`,
    );
    expect(rejectTaskWords(3n)).toBe(
      "Send task 3's money back. Nobody is paid.",
    );
    expect(cancelTaskWords(3n)).toBe(
      "Withdraw task 3. It was not taken, so no money moves.",
    );
  });
  it("under the plan sentence the date counts from the confirmation, and a task's words may follow as a second line", () => {
    expect(DATE_COUNTS_FROM_CONFIRM).toBe(
      "The date counts from when you confirm.",
    );
    expect(theTaskWords("Translate the guide")).toBe(
      "The task: \u201cTranslate the guide\u201d",
    );
    expect(theTaskWords("x".repeat(500)).length).toBeLessThan(100);
  });
  it("with no facts the call is unknown and never offered", () => {
    expect(UNKNOWN_TASK_WORDS).toBe(
      "This is about a task whose details could not be read from the network, so it cannot be confirmed from here. Try again in a moment.",
    );
  });
});
