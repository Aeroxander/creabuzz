import { describe, expect, it } from "vitest";
import {
  acceptRecord,
  agreeRecord,
  checksOwnWork,
  nextFor,
  payOwed,
  payRecord,
  postTaskRecord,
  type ProjectTask,
  projectTasks,
  readUsd,
  type TaskRecordEvent,
  takeRecord,
  type WorkerLinks,
} from "./task-record";

const FOUNDER = "f".repeat(64);
const MATE = "e".repeat(64);
const STRANGER = "a".repeat(64);
const OTHER = "b".repeat(64);
const AGENT = "c".repeat(64);
const COORD = `37001:${FOUNDER}:orbit`;
const TEAM = new Set([FOUNDER, MATE]);
const PAY_TO = "0x00000000000000000000000000000000000000cd";
const TX = `0x${"ab".repeat(32)}`;

let n = 0;
function record(
  pubkey: string,
  tags: string[][],
  content = "{}",
  at = 1_800_000_000,
): TaskRecordEvent {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    tags: [["a", COORD], ["l", "creaton-task"], ...tags],
    content,
  };
}

const openTask = (usd = "40", by = FOUNDER) =>
  record(by, [
    ["task-part", "task"],
    ["task-what", "Translate the guide"],
    ["task-usd", usd],
  ]);
const step = (
  who: string,
  task: TaskRecordEvent,
  part: string,
  extra: string[][] = [],
  at?: number,
) =>
  record(
    who,
    [["task-part", part], ["task", task.id], ...extra],
    JSON.stringify({ title: part, body: "the guide in Spanish" }),
    at,
  );

const read = (events: TaskRecordEvent[], agents = new Set<string>()) =>
  projectTasks(events, COORD, TEAM, agents);

describe("a project's tasks", () => {
  it("lists an open task with what it pays, for anyone to take", () => {
    const task = openTask();
    const [t] = read([task]);
    expect(t).toMatchObject({
      state: "open",
      usd: 40,
      openToAnyone: true,
      worker: null,
    });
    expect(nextFor(t, STRANGER, TEAM)).toBe("take");
    expect(nextFor(t, MATE, TEAM)).toBeNull();
    expect(nextFor(t, null, TEAM)).toBe("take");
  });

  it("reads dollars only as whole numbers in bounds, as the server holds them", () => {
    for (const bad of ["0", "040", "100001", "1.5", "", "x"])
      expect(readUsd(bad)).toBeNull();
    expect(readUsd("100000")).toBe(100_000);
    expect(read([openTask("0")])).toEqual([]);
    // Only the team posts tasks.
    expect(read([openTask("40", STRANGER)])).toEqual([]);
  });

  it("gives the task to the first take that was not given up, never to the team", () => {
    const task = openTask();
    const first = step(STRANGER, task, "take", [["task-pay-to", PAY_TO]], 10);
    const late = step(OTHER, task, "take", [], 20);
    const mate = step(MATE, task, "take", [], 5);
    let [t] = read([task, late, mate, first]);
    expect(t.worker).toBe(STRANGER);
    expect(t.payTo).toBe(PAY_TO);
    expect(t.state).toBe("working");
    expect(nextFor(t, STRANGER, TEAM)).toBe("hand-in");
    // Given up: the next take has it, and the one who gave up is out.
    const gaveUp = step(STRANGER, task, "give-up");
    [t] = read([task, first, late, gaveUp]);
    expect(t.worker).toBe(OTHER);
    [t] = read([task, first, gaveUp]);
    expect(t.state).toBe("open");
  });

  it("reads the wallet to be paid at from the worker's take or, for a named helper, from their accept step", () => {
    const open = openTask();
    const taken = step(STRANGER, open, "take", [["task-pay-to", PAY_TO]], 10);
    // A later step of the same worker naming the same wallet changes nothing; the latest spelling is shown.
    const SHOUT = "0x00000000000000000000000000000000000000CD";
    const again = step(STRANGER, open, "accept", [["task-pay-to", SHOUT]], 20);
    expect(read([open, taken, again])[0]?.payTo).toBe(SHOUT);
    // A take that names no wallet, then an accept that does: the accept's wallet counts.
    const bare = step(STRANGER, open, "take", [], 10);
    expect(read([open, bare, again])[0]?.payTo).toBe(SHOUT);
    // A task that names its helper: the helper's own accept step carries the wallet.
    const named = record(FOUNDER, [
      ["task-part", "task"],
      ["task-what", "Run the audit"],
      ["task-helper", STRANGER],
    ]);
    const agree = step(STRANGER, named, "accept", [["task-pay-to", PAY_TO]]);
    expect(read([named, agree])[0]).toMatchObject({
      worker: STRANGER,
      payTo: PAY_TO,
    });
    // Someone else's accept step (the team's, a stranger's) names nobody's wallet.
    const byTeam = step(MATE, named, "accept", [["task-pay-to", PAY_TO]]);
    const byOther = step(OTHER, named, "accept", [["task-pay-to", PAY_TO]]);
    expect(read([named, byTeam, byOther])[0]?.payTo).toBeNull();
  });

  it("reads two different wallets from the same worker as no wallet at all", () => {
    const open = openTask();
    const a = step(STRANGER, open, "take", [["task-pay-to", PAY_TO]], 10);
    const b = step(
      STRANGER,
      open,
      "accept",
      [["task-pay-to", "0x00000000000000000000000000000000000000ce"]],
      20,
    );
    expect(read([open, a, b])[0]?.payTo).toBeNull();
    // A step that names something that is not an address does not count as a second wallet.
    const junk = step(
      STRANGER,
      open,
      "accept",
      [["task-pay-to", "0xnope"]],
      30,
    );
    expect(read([open, a, junk])[0]?.payTo).toBe(PAY_TO);
  });

  it("is accepted only by someone on the team who is not the worker nor an agent, and keeps the payment", () => {
    const task = openTask();
    const take = step(STRANGER, task, "take", [["task-pay-to", PAY_TO]]);
    const piece = step(STRANGER, task, "evidence");
    let [t] = read([task, take, piece]);
    expect(t.state).toBe("submitted");
    expect(t.handIn?.id).toBe(piece.id);
    expect(nextFor(t, FOUNDER, TEAM)).toBe("accept");
    expect(nextFor(t, STRANGER, TEAM)).toBeNull();
    const own = step(STRANGER, task, "confirm", [["task-evidence", piece.id]]);
    const byAgent = step(AGENT, task, "confirm", [["task-evidence", piece.id]]);
    const team = new Set([...TEAM, AGENT]);
    [t] = projectTasks(
      [task, take, piece, own, byAgent],
      COORD,
      team,
      new Set([AGENT]),
    );
    expect(t.state).toBe("submitted");
    const accept = step(FOUNDER, task, "confirm", [
      ["task-evidence", piece.id],
      ["task-paid", TX],
    ]);
    [t] = read([task, take, piece, accept]);
    expect(t).toMatchObject({
      state: "accepted",
      acceptedBy: FOUNDER,
      paidTx: TX,
    });
  });

  it("reads accepted work with no payment as owing its pay, and a later confirmation naming the payment as paying it", () => {
    const task = openTask();
    const take = step(STRANGER, task, "take", [["task-pay-to", PAY_TO]]);
    const piece = step(STRANGER, task, "evidence");
    const accept = step(
      FOUNDER,
      task,
      "confirm",
      [["task-evidence", piece.id]],
      1_800_000_200,
    );
    let [t] = read([task, take, piece, accept]);
    expect(t).toMatchObject({
      state: "accepted",
      paidTx: null,
      acceptedAt: 1_800_000_200,
    });
    expect(payOwed(t)).toBe(40);
    // The team may pay it; the worker and strangers may not.
    expect(nextFor(t, FOUNDER, TEAM)).toBe("pay");
    expect(nextFor(t, MATE, TEAM)).toBe("pay");
    expect(nextFor(t, STRANGER, TEAM)).toBeNull();
    expect(nextFor(t, null, TEAM)).toBeNull();
    // The payment's record is a second confirmation of the same piece.
    const pay = {
      ...record(
        FOUNDER,
        payRecord(COORD, t, piece.id, TX).tags.filter(
          (tag) => tag[0] !== "a" && tag[0] !== "l",
        ),
        "{}",
        1_800_000_900,
      ),
    };
    [t] = read([task, take, piece, accept, pay]);
    expect(t).toMatchObject({
      state: "accepted",
      paidTx: TX,
      acceptedBy: FOUNDER,
      acceptedAt: 1_800_000_200,
    });
    expect(payOwed(t)).toBeNull();
    expect(nextFor(t, FOUNDER, TEAM)).toBeNull();
    // A payment named for another piece, or by the worker, never makes the accepted piece paid.
    const other = step(FOUNDER, task, "confirm", [
      ["task-evidence", "9".repeat(64)],
      ["task-paid", TX],
    ]);
    const byWorker = step(STRANGER, task, "confirm", [
      ["task-evidence", piece.id],
      ["task-paid", TX],
    ]);
    [t] = read([task, take, piece, accept, other, byWorker]);
    expect(t.paidTx).toBeNull();
    // Money off the record (no task-usd, a named helper) owes nothing.
    const free = record(FOUNDER, [
      ["task-part", "task"],
      ["task-what", "Tidy the notes"],
      ["task-helper", MATE],
    ]);
    const done = step(MATE, free, "evidence");
    const ok = step(FOUNDER, free, "confirm", [["task-evidence", done.id]]);
    const [f] = read([free, done, ok]);
    expect(f.state).toBe("accepted");
    expect(payOwed(f)).toBeNull();
  });

  it("writes the tags the server and the command line read", () => {
    const post = postTaskRecord(COORD, "  Translate the guide ", 40);
    expect(post.kind).toBe(47003);
    expect(post.tags).toContainEqual(["task-usd", "40"]);
    expect(post.tags).toContainEqual(["task-what", "Translate the guide"]);
    expect(post.tags).toContainEqual(["task-size", "small"]);
    expect(post.tags.some((t) => t[0] === "task-helper")).toBe(false);
    const task = read([openTask()])[0] as ProjectTask;
    expect(takeRecord(COORD, task, PAY_TO).tags).toContainEqual([
      "task-pay-to",
      PAY_TO,
    ]);
    expect(
      takeRecord(COORD, task, "0xnope").tags.some(
        (t) => t[0] === "task-pay-to",
      ),
    ).toBe(false);
    const accept = acceptRecord(COORD, task, "9".repeat(64), TX);
    expect(accept.tags).toContainEqual(["task-paid", TX]);
    expect(accept.tags).toContainEqual(["task-part", "confirm"]);
    expect(
      acceptRecord(COORD, task, "9".repeat(64), null).tags.some(
        (t) => t[0] === "task-paid",
      ),
    ).toBe(false);
  });
});

describe("checking one's own work, asked before any money moves", () => {
  // A teammate who is not an agent, and an agent the founder runs that is on the team's side of the table.
  const submittedBy = (worker: string) => {
    const task = openTask();
    const take = step(worker, task, "take");
    const piece = step(worker, task, "evidence");
    const [t] = projectTasks(
      [task, take, piece],
      COORD,
      new Set([FOUNDER, MATE]),
      new Set([worker]),
    );
    return t as ProjectTask;
  };
  const links = (over: Partial<WorkerLinks> = {}): WorkerLinks => ({
    founder: FOUNDER,
    agents: new Set([AGENT]),
    operators: new Map([[AGENT, MATE]]),
    ...over,
  });

  it("is refused for the person who runs the worker agent when the project lists someone else", () => {
    const t = submittedBy(AGENT);
    const team = new Set([FOUNDER, MATE]);
    // MATE runs the agent: the server refuses their confirmation, so the press must not be offered.
    expect(checksOwnWork(t, MATE, team, links())).toBe(true);
    expect(nextFor(t, MATE, team, links())).toBe("own-work");
    // The founder did not run it: they may accept.
    expect(checksOwnWork(t, FOUNDER, team, links())).toBe(false);
    expect(nextFor(t, FOUNDER, team, links())).toBe("accept");
    // Without the links nothing is known, as before.
    expect(nextFor(t, MATE, team)).toBe("accept");
  });

  it("lets the founder check their own agent's work only while no other person is listed", () => {
    const own = links({ operators: new Map([[AGENT, FOUNDER]]) });
    const t = submittedBy(AGENT);
    expect(checksOwnWork(t, FOUNDER, new Set([FOUNDER, MATE]), own)).toBe(true);
    expect(nextFor(t, FOUNDER, new Set([FOUNDER, MATE]), own)).toBe("own-work");
    // Alone, or with only another agent listed, the server lets them.
    expect(checksOwnWork(t, FOUNDER, new Set([FOUNDER]), own)).toBe(false);
    const withAgentMate = links({
      operators: new Map([[AGENT, FOUNDER]]),
      agents: new Set([AGENT, MATE]),
    });
    expect(
      checksOwnWork(t, FOUNDER, new Set([FOUNDER, MATE]), withAgentMate),
    ).toBe(false);
  });
});

describe("the helper's yes, with the wallet they will be paid at", () => {
  /** A task naming `STRANGER` as its helper, paying 40 dollars. */
  const namedTask = () =>
    record(FOUNDER, [
      ["task-part", "task"],
      ["task-what", "Translate the guide"],
      ["task-usd", "40"],
      ["task-helper", STRANGER],
    ]);
  const asEvent = (who: string, template: ReturnType<typeof agreeRecord>) =>
    record(
      who,
      template.tags.filter((t) => t[0] !== "a" && t[0] !== "l"),
      template.content,
    );

  it("is an accept step carrying the wallet, and the task then reads that wallet as the one to be paid at", () => {
    const task = namedTask();
    const [before] = read([task]);
    expect(before?.state).toBe("offered");
    expect(before?.payTo).toBeNull();
    const [t] = read([task]);
    if (!t) throw new Error("no task");
    const yes = agreeRecord(COORD, t, PAY_TO);
    expect(yes.tags).toEqual(
      expect.arrayContaining([
        ["task-part", "accept"],
        ["task-pay-to", PAY_TO],
        ["task", task.id],
      ]),
    );
    const [after] = read([task, asEvent(STRANGER, yes)]);
    expect(after?.payTo).toBe(PAY_TO);
    expect(after?.state).toBe("working");
  });

  it("names no wallet when someone else signs it, and refuses what is not an address", () => {
    const task = namedTask();
    const [t] = read([task]);
    if (!t) throw new Error("no task");
    const yes = agreeRecord(COORD, t, PAY_TO);
    expect(read([task, asEvent(MATE, yes)])[0]?.payTo).toBeNull();
    expect(read([task, asEvent(OTHER, yes)])[0]?.payTo).toBeNull();
    expect(() => agreeRecord(COORD, t, "0xnot")).toThrow(/address/);
    expect(() => agreeRecord(COORD, t, "")).toThrow(/address/);
  });
});
