/**
 * What the holder-side specs do on the chain and on the mock server to get a task into a state: the team's task record with a
 * worker who named a wallet, the plan announced on the chain (as the Plan sheet's press does), the take after the notice
 * (as the worker's press does), and the money sent back. Each is the app's own call builder sent from an account of the
 * chain; the page under test sees only what the chain and the server's record then say.
 */
import * as pot from "../../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../../packages/creaton-core/src/pot/pot-reads.ts";
import { walletOf } from "../../anvil/pot-chain";
import { call } from "../../anvil/rpc";
import {
  checkIn,
  type LiveProject,
  type LiveWorld,
  passTime,
} from "./live-chain";
import { FOUNDER_NOSTR, READER_KEY } from "./live-browser";
import { event, now, pubkeyOf, type Relay } from "./world";

export const DOLLAR = 1_000_000n;
export const WHAT = "Translate the guide into Spanish";
/** The person who takes the task: a key of the server, with a wallet of the chain named in their record. */
export const WORKER = pubkeyOf(READER_KEY);

const read = (to: string, data: string) => call(to, data);

/** The team's task record the plan is made for, taken by `WORKER` who named the wallet `payTo`. Returns the record's id. */
export function seedTaskRecord(
  relay: Relay,
  project: LiveProject,
  payTo: string,
  usd: number,
  what: string = WHAT,
): string {
  const at = now() - 3600;
  const task = event(
    47003,
    FOUNDER_NOSTR,
    { title: "Task", body: what },
    [
      ["a", project.coordinate],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["task-what", what],
      ["task-usd", String(usd)],
    ],
    at,
  );
  relay.seed(task);
  relay.seed(
    event(
      47003,
      WORKER,
      { title: "take", body: "" },
      [
        ["a", project.coordinate],
        ["l", "creaton-task"],
        ["task-part", "take"],
        ["e", task.id],
        ["task", task.id],
        ["task-pay-to", payTo],
      ],
      at + 60,
    ),
  );
  return task.id;
}

/** The team plans the task straight on the chain (what the Plan sheet's press sends). */
export async function planOnChain(
  world: LiveWorld,
  project: LiveProject,
  taskId: string,
  payee: string,
  usd: number,
  shareBps = 300,
): Promise<void> {
  await walletOf(world.who.founder).sendCalls(
    [
      pot.announceTaskCall({
        treasury: project.treasury,
        what: `0x${taskId}`,
        payee,
        maxDollars: BigInt(usd) * DOLLAR,
        shareBps,
      }),
    ],
    31337,
  );
}

/** How long a plan of this share is noticed before it can be taken, as the chain says. */
export async function noticeSecs(
  project: LiveProject,
  shareBps = 300,
): Promise<number> {
  return (await reads.readNoticeFor(read, project.treasury, shareBps))
    .noticeSecs;
}

/** The notice passes, the team checks in again, and `taker` takes the task (sets the money aside) with their own wallet. */
export async function takeOnChain(
  world: LiveWorld,
  project: LiveProject,
  taker: string,
  serial: bigint,
  shareBps = 300,
): Promise<void> {
  await passTime((await noticeSecs(project, shareBps)) + 5);
  await checkIn(world, project);
  await walletOf(taker).sendCalls(
    [
      pot.takeTaskCall({
        treasury: project.treasury,
        serial,
        minAmount: DOLLAR,
      }),
    ],
    31337,
  );
}

/** The team sends the money of a taken task back (nothing is paid). */
export async function sendBackOnChain(
  world: LiveWorld,
  project: LiveProject,
  serial: bigint,
): Promise<void> {
  await walletOf(world.who.founder).sendCalls(
    [pot.rejectTaskCall({ treasury: project.treasury, serial })],
    31337,
  );
}

/** What the chain says about task `serial` of the project. */
export async function taskOnChain(project: LiveProject, serial: bigint) {
  const book = await reads.readBookOf(read, project.treasury);
  if (!book) throw new Error("the project has no task book");
  return reads.readTask(read, book, serial);
}
