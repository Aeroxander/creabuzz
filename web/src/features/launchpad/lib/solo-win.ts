/**
 * "I did it": a founder with nobody else on the project makes a piece of work, hands it in and checks it in one go.
 *
 * Three records, in this order, each the same record the full task flow writes: the task (the founder is its helper;
 * the line is both the request and "Done means"; small; no due date, no limits), the hand-in (the line, and a link
 * when given), and the founder's own check. Every prefix is a consistent state: a task with no hand-in is a task in
 * progress, a hand-in with no check is work waiting for a check, and none of them is shown as done before the check.
 * A try that stops part of the way keeps where it got to (per project and task, in the tab's session storage), so a
 * retry, or the same press after a reload, carries on from the next step. Nothing is sent twice: each step is a
 * `sendOnce`, which adopts a record that already arrived.
 *
 * Nothing new is written: no record shape and no tag. The check is the founder's own, which the server allows only
 * while no other person is on the project, and which every page words and counts apart from work accepted by someone
 * else (`task-own-check.ts`).
 *
 * Pure and alias-free: `solo-win.test.mjs` drives it under `node --test`.
 */

import { founderIsAlone, type KnownAgents } from "./task-own-check.ts";

/** The steps, in order. */
export type SoloStage = "make" | "hand-in" | "check";

/** How far a try got: nothing yet, the task is made, the work is handed in. (Checked is the end.) */
export type SoloReached = "nothing" | "made" | "handed-in";

/** `full`: make, hand in, check. `finish`: hand in, check, for a task the founder already has. */
type SoloStart = "full" | "finish";

export interface SoloTask {
  id: string;
  helper: string;
  madeBy: string;
}

export interface SoloRequest {
  start: SoloStart;
  /** What was done, in one line. */
  text: string;
  /** A link that shows it, or null. */
  link: string | null;
  /** `finish` only: the task, and the ids of the work already handed in on it (so the check names what was read). */
  task?: SoloTask;
  seenEvidence?: readonly string[];
}

/** What the page knows about who is asking. */
export interface SoloWho {
  viewer: string | null;
  /** The founder of the project. */
  founder: string;
  /** The founder and everyone on the project's record. */
  team: ReadonlySet<string>;
  /** Team members known to be agent accounts. */
  agents?: KnownAgents;
  /** The signed-in account is an agent (its own profile says so). */
  viewerIsAgent: boolean;
}

export type SoloRefusal =
  | "signed-out"
  | "agent"
  | "not-founder"
  | "not-alone"
  | "not-your-task";

/** Why the solo flow is not for this person, or null when it is. It is only ever for a lone founder, never an agent. */
export function soloWinRefusal(
  who: SoloWho,
  request?: Pick<SoloRequest, "start" | "task">,
): SoloRefusal | null {
  if (!who.viewer) return "signed-out";
  if (who.viewerIsAgent) return "agent";
  if (who.viewer !== who.founder) return "not-founder";
  if (
    !founderIsAlone({
      founder: who.founder,
      helper: who.founder,
      team: who.team,
      agents: who.agents,
    })
  )
    return "not-alone";
  if (
    request?.start === "finish" &&
    (!request.task || request.task.helper !== who.viewer)
  )
    return "not-your-task";
  return null;
}

/** Where a try that stopped is kept, so a retry (or a reload) carries on: the next step and what it needs. */
export interface SoloPending {
  v: 1;
  /** The next step to run. */
  stage: SoloStage;
  task: SoloTask | null;
  text: string;
  link: string | null;
  /** Set once the work is handed in: the record the check names. */
  evidenceId: string | null;
  /** Every piece of work on the task that the check is to have been shown, the new one included. */
  seen: string[];
  at: number;
}

/** A small key-value store (the tab's session storage in the app). It may throw, and then nothing is kept. */
export interface PendingStore {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

const INDEX = "index";
const pendingKey = (coordinate: string, taskId: string) =>
  `${coordinate}:${taskId}`;
const indexKey = (coordinate: string) => `${coordinate}:${INDEX}`;

function safely<T>(run: () => T, otherwise: T): T {
  try {
    return run();
  } catch {
    return otherwise;
  }
}

function readIds(store: PendingStore, coordinate: string): string[] {
  return safely(() => {
    const raw: unknown = JSON.parse(store.get(indexKey(coordinate)) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string")
      : [];
  }, []);
}

/** The tries on this project that stopped part of the way: the newest first. */
export function pendingSoloWins(
  store: PendingStore,
  coordinate: string,
): SoloPending[] {
  const found: SoloPending[] = [];
  for (const id of readIds(store, coordinate)) {
    const pending = safely(() => {
      const raw = store.get(pendingKey(coordinate, id));
      return raw ? (JSON.parse(raw) as Partial<SoloPending>) : null;
    }, null);
    if (
      pending?.v === 1 &&
      (pending.stage === "hand-in" || pending.stage === "check") &&
      pending.task &&
      typeof pending.task.id === "string" &&
      typeof pending.text === "string"
    )
      found.push(pending as SoloPending);
  }
  return found.sort((a, b) => b.at - a.at);
}

function keep(store: PendingStore, coordinate: string, pending: SoloPending) {
  if (!pending.task) return;
  const id = pending.task.id;
  safely(() => {
    store.set(pendingKey(coordinate, id), JSON.stringify(pending));
    const ids = readIds(store, coordinate);
    if (!ids.includes(id))
      store.set(indexKey(coordinate), JSON.stringify([...ids, id]));
  }, undefined);
}

function forget(store: PendingStore, coordinate: string, taskId: string) {
  safely(() => {
    store.remove(pendingKey(coordinate, taskId));
    const ids = readIds(store, coordinate).filter((id) => id !== taskId);
    if (ids.length > 0) store.set(indexKey(coordinate), JSON.stringify(ids));
    else store.remove(indexKey(coordinate));
  }, undefined);
}

/** The three production steps, as the hook wires them (the task mutations). Each throws when it did not go through. */
export interface SoloSteps {
  /** The founder's task for themself. Resolves with the task's id. */
  make: (input: {
    helper: string;
    what: string;
    done: string;
  }) => Promise<{ id: string }>;
  /** The founder hands in the line. Resolves with the hand-in's id. */
  handIn: (
    task: SoloTask,
    input: { note: string; links: string[] },
  ) => Promise<{ id: string }>;
  /** The founder's own check of that piece. It re-reads the hand-in first and throws `EvidenceGoneError` if absent. */
  check: (
    task: SoloTask,
    input: { evidenceId: string; seen: string[] },
  ) => Promise<unknown>;
}

export type SoloResult =
  | { ok: true; task: SoloTask; evidenceId: string }
  | {
      ok: false;
      /** The step that did not go through; a retry starts there. */
      stage: SoloStage;
      reached: SoloReached;
      error: unknown;
      pending: SoloPending | null;
    };

/** Thrown by `runSoloWin` when the flow is not for this person: nothing was sent. */
export class SoloRefusedError extends Error {
  readonly refusal: SoloRefusal;
  constructor(refusal: SoloRefusal) {
    super(`The solo flow is not for this account (${refusal}).`);
    this.name = "SoloRefusedError";
    this.refusal = refusal;
  }
}

/** Waits for the check to find the hand-in it names: the server may not show it the moment it is accepted. */
export const CHECK_RETRY_MS = [300, 700, 1500, 3000] as const;

const isEvidenceGone = (error: unknown) =>
  error instanceof Error && error.name === "EvidenceGoneError";

const REACHED: Record<SoloStage, SoloReached> = {
  make: "nothing",
  "hand-in": "made",
  check: "handed-in",
};

/**
 * Run the steps from `from` (a try that stopped) or from the start of `request`. Refuses, sending nothing, for an
 * agent account and for a founder who has someone else on the project.
 *
 * The check re-reads the hand-in before it is written; a read that does not yet show it is tried again a few times,
 * with a short wait, before it reports a failure. Every other failure is reported at once, with the step it was.
 */
export async function runSoloWin(input: {
  who: SoloWho;
  coordinate: string;
  request: SoloRequest;
  steps: SoloSteps;
  store: PendingStore;
  /** A try that stopped: it carries on from its next step. */
  from?: SoloPending | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<SoloResult> {
  const { who, coordinate, steps, store } = input;
  const request = input.from
    ? ({
        start: "finish",
        text: input.from.text,
        link: input.from.link,
        task: input.from.task ?? undefined,
      } satisfies SoloRequest)
    : input.request;
  const refusal = soloWinRefusal(who, request);
  if (refusal) throw new SoloRefusedError(refusal);
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = input.now ?? Date.now;
  const text = request.text.trim();
  const link = request.link?.trim() || null;

  let pending: SoloPending | null = input.from ?? null;
  let task: SoloTask | null = pending?.task ?? request.task ?? null;
  let stage: SoloStage = pending?.stage ?? (task ? "hand-in" : "make");
  let evidenceId = pending?.evidenceId ?? null;
  let seen = pending?.seen ?? [...(request.seenEvidence ?? [])];
  const stopped = (error: unknown): SoloResult => ({
    ok: false,
    stage,
    reached: REACHED[stage],
    error,
    pending,
  });
  const remember = () => {
    pending = { v: 1, stage, task, text, link, evidenceId, seen, at: clock() };
    // A task that does not exist yet has nothing to be kept under: the same words sent again adopt what arrived.
    if (task) keep(store, coordinate, pending);
  };

  if (stage === "make") {
    try {
      const made = await steps.make({
        helper: who.founder,
        what: text,
        done: text,
      });
      task = { id: made.id, helper: who.founder, madeBy: who.founder };
    } catch (error) {
      return stopped(error);
    }
    stage = "hand-in";
    remember();
  }
  if (stage === "hand-in" && task) {
    try {
      const handed = await steps.handIn(task, {
        note: text,
        links: link ? [link] : [],
      });
      evidenceId = handed.id;
      seen = [...new Set([...seen, handed.id])];
    } catch (error) {
      return stopped(error);
    }
    stage = "check";
    remember();
  }
  if (stage === "check" && task && evidenceId) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await steps.check(task, { evidenceId, seen });
        break;
      } catch (error) {
        if (!isEvidenceGone(error) || attempt >= CHECK_RETRY_MS.length)
          return stopped(error);
        await sleep(CHECK_RETRY_MS[attempt]);
      }
    }
    forget(store, coordinate, task.id);
    return { ok: true, task, evidenceId };
  }
  return stopped(new Error("Nothing to run."));
}
