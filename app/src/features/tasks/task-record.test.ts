import { describe, expect, it } from "vitest";
import {
  acceptRecord,
  checksOwnWork,
  nextFor,
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
