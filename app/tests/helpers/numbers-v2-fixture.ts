/**
 * A version 2 project-numbers record (kind 39009) for the unit tests and the Playwright specs, made from the ONE example
 * file both the server and the app test against (`docs/next-version/record-v2-example.json`, made by running the real
 * contracts; `docs/next-version/RECORD-V2.md` section 7). The example is never retyped here: a fixture is the example,
 * moved to the project and the moment a test asks for, then changed by a patch.
 */
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The example, read from disk where it lives (a JSON import needs an attribute under Playwright's loader and none under
 * vitest). Both run from the app's folder, so the path is from there.
 */
const example: unknown = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../docs/next-version/record-v2-example.json"),
    "utf8",
  ),
);

type Json = Record<string, unknown>;

/** Anvil's second account: the founder's wallet (the example's founder and runner). */
export const FOUNDER_EVM = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
/** Anvil's fourth account: a backer in the example's holders list. */
export const BACKER_EVM = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
/** A wallet that holds nothing in the example. */
export const STRANGER_EVM = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";

/** The example as the file has it (a deep copy: a test may change it). */
export function exampleRecord(): Json {
  return structuredClone(example) as Json;
}

/** The identity a project record's coordinate gives: the id and the chain key the contracts would know it by. */
export function chainIdentityV2(coordinate: string, founder = FOUNDER_EVM) {
  const projectId = projectIdOf(coordinate);
  return { projectId, key: chainKeyOf(founder, projectId) };
}

const at = (o: Json, path: string[]): Json => {
  let cursor = o;
  for (const step of path) cursor = cursor[step] as Json;
  return cursor;
};

/** Move every point in time of a record by `delta` seconds (durations such as active seconds stay as they are). */
export function shiftTimes(content: Json, delta: number): void {
  const shift = (o: Json, name: string) => {
    if (typeof o[name] === "number") o[name] = (o[name] as number) + delta;
  };
  shift(content, "launchedAt");
  shift(content, "builtAt");
  shift(content, "firstBackedAt");
  shift(at(content, ["asOf"]), "time");
  shift(at(content, ["money"]), "arrivalEnd");
  const pending = at(content, ["allowance"]).pending as Json | null;
  if (pending) {
    shift(pending, "proposedAt");
    shift(pending, "applicableAt");
  }
  for (const name of ["lastCheckIn", "activeUntil"])
    shift(at(content, ["clock"]), name);
  shift(at(content, ["door"]), "shutsAt");
  const quiet = at(content, ["quiet"]);
  for (const name of ["since", "quietFrom", "dormantFrom", "windableFrom"])
    shift(quiet, name);
  if (quiet.next) shift(quiet.next as Json, "at");
  if (content.windDown) shift(content.windDown as Json, "at");
  for (const grant of (at(content, ["team"]).grants as Json[]) ?? []) {
    if (grant.cliff) shift(grant.cliff as Json, "endsAtIfActive");
    shift(grant, "fullyVestedAtIfActive");
    if (grant.forfeit) shift(grant.forfeit as Json, "burnAt");
  }
  const ledger = content.ledger as Json | undefined;
  if (ledger) {
    shift(ledger, "lastSettle");
    shift(ledger, "arrivalEnd");
    shift(ledger, "arrivalStart");
  }
  const tasks = content.tasks as Json | null | undefined;
  if (tasks) shiftTasks(tasks, shift);
  shiftSocial(content, shift);
}

/** The points in time of the step 3 keys: the feed's hours and items and the streak's last update (the windows are durations). */
function shiftSocial(content: Json, shift: (o: Json, name: string) => void) {
  const feed = content.feed as Json | null | undefined;
  if (feed) {
    for (const hour of (feed.hours as Json[] | undefined) ?? [])
      shift(hour, "at");
    for (const item of (feed.items as Json[] | undefined) ?? []) {
      shift(item, "at");
      shift(item, "date");
    }
  }
  const updates = (content.streaks as Json | null | undefined)?.updates as
    | Json
    | undefined;
  if (updates) shift(updates, "lastAt");
}

/** The points in time of a record's `tasks` section (the durations in `limits` and `cut` stay as they are). */
function shiftTasks(tasks: Json, shift: (o: Json, name: string) => void) {
  shift(tasks, "nextExpiry");
  if (tasks.next) shift(tasks.next as Json, "at");
  const cap = tasks.cap as Json | undefined;
  for (const free of (cap?.frees as Json[] | undefined) ?? [])
    shift(free, "at");
  for (const row of (tasks.list as Json[] | undefined) ?? [])
    for (const name of [
      "announcedAt",
      "noticeEnd",
      "expiresAt",
      "takenAt",
      "deadline",
      "resolvedAt",
    ])
      shift(row, name);
}

/** The example's `tasks` section, kept for `withTasks`: the fixture leaves it out unless a test asks, so a step 1 test is a step 1 record. */
const stashed = new WeakMap<Json, Json | null>();

/**
 * A `patch` that puts the example's task queue back into the record, moved in time with the rest of it, and then changes it
 * (`edit` may also replace a row's `what` so it ties to a team record, change a state, or empty the list). The example's
 * own numbers stay the example's: a test reads them from the parsed record, never from a copy.
 */
export function withTasks(
  edit?: (tasks: Json, content: Json) => void,
): (content: Json) => void {
  return (content) => {
    const tasks = stashed.get(content);
    if (tasks === undefined) throw new Error("withTasks: not a fixture record");
    content.tasks = tasks === null ? null : structuredClone(tasks);
    if (content.tasks) edit?.(content.tasks as Json, content);
  };
}

/** The row of `tasks` with this serial, for a test that changes it. */
export function taskRow(tasks: Json, serial: number): Json {
  const row = (tasks.list as Json[]).find((r) => r.serial === serial);
  if (!row) throw new Error(`the example has no task ${serial}`);
  return row;
}

export interface NumbersV2Options {
  /** The project's record address (`37001:<founder>:<id>`): the chain key and project id follow from it. */
  coordinate: string;
  /** Unix seconds "now": the record was built 100 seconds before it. */
  now: number;
  /** Change the record before it is returned (a field, a state, a list); `withTasks(...)` brings the task queue in. */
  patch?: (content: Json) => void;
}

/** The record's content (JSON-ready) for the project at `coordinate`, as of just before `now`. */
export function numbersV2Content(o: NumbersV2Options): Json {
  const content = exampleRecord();
  const exampleBuilt = content.builtAt as number;
  shiftTimes(content, o.now - 100 - exampleBuilt);
  // The queue is out unless `withTasks` brings it back, so a test that does not ask for tasks sees a record with none.
  stashed.set(content, (content.tasks as Json | null | undefined) ?? null);
  delete content.tasks;
  const { projectId, key } = chainIdentityV2(o.coordinate);
  content.projectId = projectId;
  content.key = key;
  content.founder = FOUNDER_EVM;
  o.patch?.(content);
  return content;
}

export type SocialKey = "held" | "feed" | "streaks" | "established";

/**
 * A `patch` for one or more of the step 3 keys: a value replaces the example's, `null` is the server saying it could not
 * work it out, and `"absent"` takes the key out (a record from an older server). A key not named stays as the example has it.
 */
export function withSocial(
  parts: Partial<Record<SocialKey, Json | null | "absent">>,
): (content: Json) => void {
  return (content) => {
    for (const [key, value] of Object.entries(parts)) {
      if (value === "absent") delete content[key];
      else content[key] = value === undefined ? null : value;
    }
  };
}
