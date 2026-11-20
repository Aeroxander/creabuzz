// biome-ignore-all lint/style/noNonNullAssertion: each read is asserted non-null on the line before it is used
/**
 * What the task loops of `scripts/pot-app-loop.sh` share: a project launched and backed through the app's own builders, the
 * team's task record as the app reads it, the numbers the gates look at, and a refusal read the way a person would read it.
 */
import { describe, expect } from "vitest";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  type TASK_BOOK_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { planBack } from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { potProblem } from "../../src/features/money/pot-copy";
import { WalletStepError } from "../../src/features/money/wallet";
import type { Ready } from "../../src/features/pot/use-pot";
import type { ChainTask } from "../../src/features/tasks/chain/types";
import type { ProjectTask } from "../../src/features/tasks/task-record";
import { walletOf } from "./pot-chain";
import { call, RPC } from "./rpc";

export const run = RPC ? describe : describe.skip;
export const DOLLAR = 1_000_000n;
export const SHARE = 10n ** 18n;
export const CHAIN = 31337;
export const read = (to: string, data: string) => call(to, data);
/** The team's people as the app keys them (a public key, not a wallet). */
export const FOUNDER_KEY = "f".repeat(64);
export const WORKER_KEY = "c".repeat(64);

export async function view(
  abi: typeof LAUNCHER_ABI | typeof TREASURY_ABI | typeof TASK_BOOK_ABI,
  to: string,
  name: string,
  args: (bigint | string)[] = [],
) {
  return decodeReturn(
    abi,
    name,
    await read(to, encodeCall(abi, name, args)),
    args.length,
  );
}

export const readyOf = (account: string): Ready => ({
  address: account,
  read,
  wallet: walletOf(account),
});

/** A transaction as the app sends it: the connected account's own wallet. */
export async function send(
  account: string,
  inner: pot.PotCall,
): Promise<string> {
  const sent = await walletOf(account).sendCalls([inner], CHAIN);
  return sent.txHash.toLowerCase();
}

/** A call the chain must refuse: the error the app would show, and the sentence it says for it. */
export async function refused(
  account: string,
  inner: pot.PotCall,
  action: Parameters<typeof potProblem>[1],
): Promise<string> {
  const failed = await walletOf(account)
    .sendCalls([inner], CHAIN)
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(failed).toBeInstanceOf(WalletStepError);
  const words = potProblem(failed, action);
  // A sentence, not an error name or a hex string: nothing a person cannot read.
  expect(words.length).toBeGreaterThan(20);
  expect(words).not.toMatch(/0x[0-9a-f]{8}|[a-z][A-Z][a-z]|revert|Error/);
  return words;
}

/** The team's task record, as the app reads it: what a plan of it names, and who is to be paid. */
export function record(
  id: string,
  usd: number,
  payTo: string | null,
): ProjectTask {
  return {
    id,
    author: FOUNDER_KEY,
    at: 1_700_000_000,
    what: "Translate the guide",
    usd,
    openToAnyone: false,
    worker: WORKER_KEY,
    payTo,
    state: "submitted",
    handIn: { id: "b2".repeat(32), at: 1_700_000_100, note: "The guide" },
    acceptedBy: null,
    acceptedAt: null,
    paidTx: null,
  };
}

/** The row the app holds for a task it has just read (nothing a read does not give). */
export function rowOf(task: reads.ChainTaskNow): ChainTask {
  return {
    ...task,
    atMostNow: null,
    pay: 0n,
    capBps: 0,
    resolvedAt: null,
    resolvedTx: null,
    repeatOf: null,
    notes: null,
  };
}

export const idHex = (id: string) => `0x${id}`;

export interface World {
  dollar: string;
  launcher: string;
  unit: number;
}

export interface Project {
  key: string;
  treasury: string;
  book: string;
  shares: string;
  team: string;
  vester: string;
  founder: string;
}

export async function launch(
  chain: World,
  founder: string,
  tag: string,
): Promise<Project> {
  const [settingsHash] = await view(
    LAUNCHER_ABI,
    chain.launcher,
    "settingsHash",
  );
  const projectId = projectIdOf(`37001:${"ab".repeat(32)}:${tag}`);
  await walletOf(founder).sendCalls(
    [
      pot.launchCall({
        launcher: chain.launcher,
        projectId,
        name: tag,
        symbol: tag.slice(0, 4).toUpperCase(),
        ratePpm: 1000,
        teamPool: 10_000_000n * SHARE,
        settingsHash: settingsHash as string,
      }),
    ],
    CHAIN,
  );
  const key = chainKeyOf(founder, projectId);
  const parts = await state.readProjectParts(read, chain.launcher, key);
  const book = await reads.readBookOf(read, parts.treasury);
  expect(book).not.toBeNull();
  return { ...parts, key, book: book as string };
}

export async function back(
  chain: World,
  p: Project,
  who: string,
  dollars: bigint,
) {
  const plan = await planBack(read, {
    dollar: chain.dollar,
    treasury: p.treasury,
    amount: dollars * DOLLAR,
    to: who,
  });
  await walletOf(who).sendCalls(plan!.calls, CHAIN);
}

export const checkIn = (founder: string, p: Project, n: number) =>
  send(
    founder,
    pot.checkInCall(p.treasury, `0x${n.toString(16).padStart(64, "0")}`),
  );

export const potOf = async (p: Project) =>
  reads.asBigint(
    (await reads.ask(read, TREASURY_ABI, p.treasury, "pot", []))[0],
  );

export const dollars = (chain: World, who: string) =>
  reads.balanceOf(read, chain.dollar, who);

/** The record's numbers the gates read, as far as these gates look at them (the chain supplies the rest). */
export function numbersOf(
  p: Project,
  chain: World,
  runner: { address: string; isPair: boolean; signers: string[] | null },
  money: bigint,
): ProjectNumbers {
  return {
    chainId: CHAIN,
    key: p.key,
    launcher: chain.launcher,
    unit: chain.unit,
    windDown: null,
    limits: { cliffUnits: 13 },
    runner,
    money: { pot: money },
    contracts: {
      treasury: p.treasury,
      shares: p.shares,
      team: p.team,
      vester: p.vester,
      dollar: chain.dollar,
    },
  } as unknown as ProjectNumbers;
}
