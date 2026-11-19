/**
 * A project's tasks, read from its records, and the records the Tasks tab writes. Pure, so `task-record.test.ts` holds
 * it to the server's rules (`crates/buzz-relay/src/handlers/launch_update_authority.rs`) and the command line's
 * (`buzz launchpad tasks`):
 *
 * - A task is a record with `task-part` = task, signed by someone on the team. It names its helper (`task-helper`), or
 *   it is open to anyone and says what it pays in whole dollars (`task-usd`).
 * - Someone outside the team takes an open task (`take`), and may name where to be paid (`task-pay-to`). Its helper is
 *   the first take, by the time it carries and then id, whose signer has not given it up: the server refuses a
 *   second take while one is live.
 * - The helper hands work in (`evidence`). Someone on the team who is not the helper (and not an agent) accepts it
 *   (`confirm`), with the payment's transaction (`task-paid`) when money moved.
 *
 * A step counts only from the party allowed to sign it, whatever else is stored.
 */
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";

export const TASK_LABEL = "creaton-task";
/** The most a task may pay, in whole dollars (the server's bound). */
const TASK_USD_MAX = 100_000;
/** The longest "what" a task may say. */
export const TASK_WHAT_MAX = 280;

export type TaskState =
  | "open"
  | "offered"
  | "working"
  | "submitted"
  | "accepted"
  | "given-up"
  | "cancelled";

export interface TaskRecordEvent {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

interface HandIn {
  id: string;
  at: number;
  note: string;
}

export interface ProjectTask {
  id: string;
  /** Who on the team posted it. */
  author: string;
  at: number;
  what: string;
  /** What it pays, in whole dollars; null for a task that names its helper and says nothing about money. */
  usd: number | null;
  /** True when it named no helper: anyone outside the team can take it. */
  openToAnyone: boolean;
  /** Who does the work: the helper it names, or its taker. Null while an open task waits for a taker. */
  worker: string | null;
  /** Where the taker asked to be paid. */
  payTo: string | null;
  state: TaskState;
  /** The newest work handed in that nobody on the team has answered, or the piece that was accepted. */
  handIn: HandIn | null;
  /** Who accepted the work, and the payment they recorded with it. */
  acceptedBy: string | null;
  paidTx: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

function first(event: TaskRecordEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && typeof tag[1] === "string" ? tag[1] : null;
}

function noteOf(event: TaskRecordEvent): string {
  try {
    const body: unknown = JSON.parse(event.content);
    if (body && typeof body === "object") {
      const { note, body: text } = body as Record<string, unknown>;
      if (typeof note === "string") return note;
      if (typeof text === "string") return text;
    }
  } catch {
    // Not JSON: the words are the content.
  }
  return event.content;
}

/** Whole dollars from 1 to 100,000, as the server holds `task-usd`; null otherwise. */
export function readUsd(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return null;
  const usd = Number(value);
  return usd <= TASK_USD_MAX ? usd : null;
}

/** Earliest first by the time a record carries, then by id: how the server picks the first take. */
function earliest<T extends { created_at: number; id: string }>(
  list: readonly T[],
): T | undefined {
  return [...list].sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
  )[0];
}

/**
 * Every task of the project at `coordinate`, newest first. `team` is the founder and the team members; `agents` are
 * the accounts labelled as agents, whose confirmations never count.
 */
export function projectTasks(
  events: readonly TaskRecordEvent[],
  coordinate: string,
  team: ReadonlySet<string>,
  agents: ReadonlySet<string> = new Set(),
): ProjectTask[] {
  const mine = events.filter(
    (e) =>
      first(e, "a") === coordinate &&
      e.tags.filter((t) => t[0] === "task-part").length === 1,
  );
  const steps = new Map<string, TaskRecordEvent[]>();
  for (const event of mine) {
    const task = first(event, "task");
    if (first(event, "task-part") === "task" || !task || !HEX64.test(task))
      continue;
    const list = steps.get(task) ?? [];
    list.push(event);
    steps.set(task, list);
  }
  const out: ProjectTask[] = [];
  const seen = new Set<string>();
  for (const event of mine) {
    if (first(event, "task-part") !== "task" || seen.has(event.id)) continue;
    seen.add(event.id);
    if (!team.has(event.pubkey)) continue;
    const what = (first(event, "task-what") ?? "").trim();
    if (!what) continue;
    const named = first(event, "task-helper");
    const usd = readUsd(first(event, "task-usd"));
    if (named !== null ? !HEX64.test(named) : usd === null) continue;
    out.push(
      readTask(
        event,
        what,
        named,
        usd,
        steps.get(event.id) ?? [],
        team,
        agents,
      ),
    );
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}

function readTask(
  task: TaskRecordEvent,
  what: string,
  named: string | null,
  usd: number | null,
  steps: readonly TaskRecordEvent[],
  team: ReadonlySet<string>,
  agents: ReadonlySet<string>,
): ProjectTask {
  const part = (e: TaskRecordEvent) => first(e, "task-part");
  const left = new Set(
    steps.filter((s) => part(s) === "give-up").map((s) => s.pubkey),
  );
  const take =
    named === null
      ? earliest(
          steps.filter(
            (s) =>
              part(s) === "take" && !team.has(s.pubkey) && !left.has(s.pubkey),
          ),
        )
      : undefined;
  const worker = named ?? take?.pubkey ?? null;
  const byWorker = (name: string) =>
    steps.filter((s) => part(s) === name && s.pubkey === worker);
  const byTeam = (name: string) =>
    steps.filter(
      (s) => part(s) === name && team.has(s.pubkey) && s.pubkey !== worker,
    );
  const pieces = byWorker("evidence");
  const sentBack = new Set(
    byTeam("send-back").map((s) => first(s, "task-evidence")),
  );
  const confirms = byTeam("confirm").filter((s) => !agents.has(s.pubkey));
  const accepted = earliest(
    confirms.filter((c) => {
      const piece = first(c, "task-evidence");
      return (
        piece !== null &&
        !sentBack.has(piece) &&
        pieces.some((p) => p.id === piece)
      );
    }),
  );
  const answered = new Set([
    ...sentBack,
    ...confirms.map((c) => first(c, "task-evidence")),
  ]);
  const waiting = pieces
    .filter((p) => !answered.has(p.id))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0];
  const acceptedPiece = accepted
    ? pieces.find((p) => p.id === first(accepted, "task-evidence"))
    : undefined;
  const handInOf = (e: TaskRecordEvent | undefined): HandIn | null =>
    e ? { id: e.id, at: e.created_at, note: noteOf(e) } : null;
  const agreed =
    take !== undefined ||
    byWorker("accept").length > 0 ||
    pieces.length > 0 ||
    worker === task.pubkey;
  const state: TaskState = accepted
    ? "accepted"
    : named !== null && byWorker("give-up").length > 0
      ? "given-up"
      : byTeam("cancel").length > 0
        ? "cancelled"
        : waiting
          ? "submitted"
          : worker === null
            ? "open"
            : agreed
              ? "working"
              : "offered";
  const paid = accepted ? first(accepted, "task-paid") : null;
  const payTo = take ? first(take, "task-pay-to") : null;
  return {
    id: task.id,
    author: task.pubkey,
    at: task.created_at,
    what,
    usd,
    openToAnyone: named === null,
    worker,
    payTo: payTo && ADDRESS.test(payTo) ? payTo : null,
    state,
    handIn: handInOf(acceptedPiece ?? waiting),
    acceptedBy: accepted?.pubkey ?? null,
    paidTx: paid && TX.test(paid) ? paid : null,
  };
}

/** A record the app signs: kind, words and tags. */
export interface RecordTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The size the command line and the web app read, from what the task pays. */
function sizeFor(usd: number): "small" | "medium" | "large" {
  return usd <= 100 ? "small" : usd <= 1_000 ? "medium" : "large";
}

/** A task open to anyone that pays `usd` whole dollars. The finish line is what it says. */
export function postTaskRecord(
  coordinate: string,
  what: string,
  usd: number,
): RecordTemplate {
  const words = what.trim().slice(0, TASK_WHAT_MAX);
  return {
    kind: KIND_LAUNCH_UPDATE,
    content: JSON.stringify({ title: "Task", body: words }),
    tags: [
      ["a", coordinate],
      ["l", TASK_LABEL],
      ["task-part", "task"],
      ["task-what", words],
      ["task-done", words],
      ["task-size", sizeFor(usd)],
      ["task-usd", String(usd)],
    ],
    created_at: nowSeconds(),
  };
}

function stepRecord(
  coordinate: string,
  task: ProjectTask,
  part: string,
  title: string,
  extra: string[][],
  note = "",
): RecordTemplate {
  return {
    kind: KIND_LAUNCH_UPDATE,
    content: JSON.stringify(
      note ? { title, body: note, note } : { title, body: "" },
    ),
    tags: [
      ["a", coordinate],
      ["l", TASK_LABEL],
      ["task-part", part],
      ["e", task.id],
      ["task", task.id],
      ["p", task.author],
      ...extra,
    ],
    created_at: nowSeconds(),
  };
}

/** Take an open task, naming the wallet to be paid at when there is one. */
export function takeRecord(
  coordinate: string,
  task: ProjectTask,
  payTo: string | null,
): RecordTemplate {
  return stepRecord(
    coordinate,
    task,
    "take",
    "Task taken",
    payTo && ADDRESS.test(payTo) ? [["task-pay-to", payTo]] : [],
  );
}

/** Hand work in on a task, with a few words of what was done and where to look. */
export function handInRecord(
  coordinate: string,
  task: ProjectTask,
  note: string,
): RecordTemplate {
  return stepRecord(
    coordinate,
    task,
    "evidence",
    "Work handed in",
    [],
    note.trim().slice(0, 1_000),
  );
}

/** Accept a piece of handed-in work, with the payment's transaction when money moved. */
export function acceptRecord(
  coordinate: string,
  task: ProjectTask,
  handIn: string,
  paidTx: string | null,
): RecordTemplate {
  const extra: string[][] = [["task-evidence", handIn]];
  if (paidTx && TX.test(paidTx)) extra.push(["task-paid", paidTx]);
  return stepRecord(coordinate, task, "confirm", "Work accepted", extra);
}

/** What the app knows about who runs whom, so it can tell when accepting would be checking one's own work. */
export interface WorkerLinks {
  /** The project's founder. */
  founder: string;
  /** Accounts labelled as agents. */
  agents: ReadonlySet<string>;
  /** Each agent account and the person who runs it, from the agent's own profile. */
  operators: ReadonlyMap<string, string>;
}

/**
 * Whether `me` accepting this task's work would be checking their own work or their agent's, which the server refuses.
 * It lets the founder do it only while the project lists no other person who could (the server's `founder_alone`). The
 * app asks before any money moves: a payment sent for a confirmation the server then refuses cannot be taken back.
 */
export function checksOwnWork(
  task: ProjectTask,
  me: string,
  team: ReadonlySet<string>,
  links: WorkerLinks,
): boolean {
  const worker = task.worker;
  if (worker === null) return false;
  if (worker !== me && links.operators.get(worker) !== me) return false;
  const another = [...team].some(
    (member) =>
      member !== links.founder &&
      member !== worker &&
      !links.agents.has(member),
  );
  return !(me === links.founder && !another);
}

/** What the person can do on a task, from where they stand. */
export function nextFor(
  task: ProjectTask,
  me: string | null,
  team: ReadonlySet<string>,
  links?: WorkerLinks,
): "take" | "hand-in" | "accept" | "own-work" | null {
  if (!me) return task.state === "open" ? "take" : null;
  if (task.state === "open" && !team.has(me)) return "take";
  if (
    task.worker === me &&
    (task.state === "working" || task.state === "offered")
  )
    return "hand-in";
  if (task.state === "submitted" && team.has(me) && task.worker !== me)
    return links && checksOwnWork(task, me, team, links)
      ? "own-work"
      : "accept";
  return null;
}
