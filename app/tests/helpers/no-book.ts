import { selectorOf } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";

const TASKS = selectorOf("tasks()");

/**
 * For a unit test that answers every read with one number (the allowance box): the question "which task book does this
 * project have" (`Treasury.tasks`) is answered "none", so the one-door look at the chain finds no plan and the test is about
 * what it was about. A test of the plan door itself uses the real answers of `plan-scene` instead.
 */
export function noBook(data: string): string | null {
  return data.toLowerCase().startsWith(TASKS) ? `0x${"0".repeat(64)}` : null;
}
