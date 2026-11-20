/**
 * Who is named on a plan, and what the plan is called, for the lines every reader sees (plan section 5.3). A name comes from
 * the profile of the worker whose own record names the same wallet; without one the wallet shows by its start and end. The
 * team's words for the task are used only when the plan ties to that record (`tieOf`): a plan that does not tie is "a task".
 */
import { nameOf, type ProfileMetadata } from "../../../../lib/profiles";
import type { ProjectTask } from "../../task-record";
import { tieOf } from "../state";
import type { ChainTask } from "../types";
import { shortAddress } from "./holder-words";

type Profiles = Record<string, ProfileMetadata> | undefined;

const sameWallet = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** A wallet's name: the worker's profile name when their record names this wallet, else the wallet's start and end. */
function walletName(
  wallet: string,
  task: ProjectTask | null,
  profiles: Profiles,
): string {
  return task?.worker && sameWallet(task.payTo, wallet)
    ? nameOf(profiles, task.worker)
    : shortAddress(wallet);
}

/** Who is to be paid: null when the plan names nobody (so the line says "whoever takes it"). */
export function payeeName(
  row: ChainTask,
  task: ProjectTask | null,
  profiles: Profiles,
): string | null {
  return row.payee === null ? null : walletName(row.payee, task, profiles);
}

/** Who took it: null before a take. */
export function takerName(
  row: ChainTask,
  task: ProjectTask | null,
  profiles: Profiles,
): string | null {
  return row.takenBy === null ? null : walletName(row.takenBy, task, profiles);
}

/** The team's own words for the plan, only when the plan ties to the record; else null (the line says "a task"). */
export function tiedWords(
  row: ChainTask,
  task: ProjectTask | null,
): string | null {
  return task !== null && tieOf(row, task).ok ? task.what : null;
}
