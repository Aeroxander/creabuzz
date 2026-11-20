/**
 * The scene of the "Money you can claim" tests: a project whose example queue holds a task that ended with a claim waiting
 * for one account, a task still running with a claim of another, and a wallet in the page that answers as the chain would.
 * `chain` and `numbers` are live: a test reads them after `notesScene()` set them. Nothing is retyped from the example: a
 * figure is read from the parsed record, and a row the chain says otherwise about goes through the chain's answers.
 */
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { forgetPending, sendKey } from "../../src/features/money/pending-sends";
import type { ChainTask } from "../../src/features/tasks/chain/types";
import { BACKER_EVM } from "./numbers-v2-fixture";
import { SERVER } from "./money-harness";
import { installPotChain, type PotChain } from "./pot-chain";
import { nameTheNetwork } from "./pot-harness";
import { queueOf, sceneAnswers, sceneNumbers } from "./plan-scene";
import { taskRow } from "./numbers-v2-fixture";

/** The account the example lists as holding a claim on its returned task (serial 4): the claim is ready to be paid. */
export const CLAIMANT = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
/** The account the example lists as holding a claim on its taken task (serial 6): the task is still running. */
export const STAYER = BACKER_EVM;
export const ENDED_SERIAL = 4;
export const RUNNING_SERIAL = 6;

export let chain: PotChain;
export let numbers: ProjectNumbers;

/**
 * Makes the scene: the example's queue (moved to now), the build's network named, and a wallet showing `account`. `rows`
 * replaces what the chain answers rows with (a claim the record does not list, a task that moved since it was made).
 */
export function notesScene(
  options: {
    account?: string;
    patch?: (content: Record<string, unknown>) => void;
    rows?: (queue: ProjectNumbers["tasks"] & object) => ChainTask[];
  } = {},
) {
  numbers = sceneNumbers(options.patch);
  nameTheNetwork(numbers);
  const rows = options.rows ? options.rows(queueOf(numbers)) : undefined;
  chain = installPotChain({
    account: options.account ?? CLAIMANT,
    answers: sceneAnswers(numbers, rows ? { rows } : {}) as never,
  });
  return { numbers, chain };
}

/** A change to a row of the queue the chain answers from (the record keeps the row as it was). */
export function withRow(
  serial: number,
  over: Partial<ChainTask>,
): (queue: ProjectNumbers["tasks"] & object) => ChainTask[] {
  return (queue) =>
    (queue as { list: ChainTask[] }).list.map((r) =>
      r.serial === BigInt(serial) ? { ...r, ...over } : r,
    );
}

/** The row with this serial of the scene's queue. */
export function rowOf(serial: number): ChainTask {
  const row = queueOf(numbers).list.find((r) => r.serial === BigInt(serial));
  if (!row) throw new Error(`the example has no task ${serial}`);
  return row;
}

/** Content patch: the taken task's deadline has passed and nobody settled it (the claim on it is payable in full). */
export function runOut(content: Record<string, unknown>): void {
  const row = taskRow(content.tasks as Record<string, unknown>, RUNNING_SERIAL);
  const past = (content.asOf as { time: number }).time - 10;
  row.deadline = past;
  row.expiresAt = past;
}

/** Called once at the top of a test file. */
export function notesSceneHooks() {
  beforeEach(() => {
    applyServerSettings({ investing: true, self: SERVER });
  });
  afterEach(() => {
    // A send that may have landed is remembered per step and account: no test leaves one for the next.
    if (numbers)
      for (const serial of [ENDED_SERIAL, RUNNING_SERIAL])
        for (const who of [CLAIMANT, STAYER])
          forgetPending(
            sendKey(
              `claim-note:${numbers.chainId}:${numbers.contracts.treasury}:${serial}:${who}`,
              who,
            ),
          );
    cleanup();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    localStorage.clear();
    applyServerSettings(null);
  });
}

// --- Logs ---------------------------------------------------------------------------------------------------------------

import { signatureOf } from "@creaton/core/pot/abi-codec.ts";
import { TASK_BOOK_ABI } from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";

/** The topic of the book's claim-written event, from the build's own ABI. */
export const MINTED_TOPIC = (() => {
  const item = TASK_BOOK_ABI.find(
    (i) => i.type === "event" && i.name === "NoteMinted",
  );
  if (!item) throw new Error("no NoteMinted");
  return topicOf(signatureOf(item));
})();

const word = (n: bigint | string) =>
  `0x${(typeof n === "bigint" ? n.toString(16) : n.replace(/^0x/, "")).padStart(64, "0")}`;

/** A log of the book writing a claim for `holder` on task `serial`, in block `block`, from transaction `tx`. */
export function mintedLog(input: {
  book: string;
  serial: bigint;
  holder: string;
  block: number;
  tx?: string;
}) {
  return {
    address: input.book,
    topics: [
      MINTED_TOPIC,
      word(input.serial),
      word(input.holder.toLowerCase()),
    ],
    data: "0x",
    blockNumber: `0x${input.block.toString(16)}`,
    transactionHash: input.tx ?? word(BigInt(input.block)),
  };
}

type Params = { fromBlock: string; toBlock: string };

/**
 * Makes the wallet's `eth_getLogs` answer by range, from `logs`, and its newest block `head`; returns every range asked.
 * `refuse(span)` makes a range wider than `span` blocks fail the way a node that limits ranges does.
 */
export function serveLogs(
  logs: ReturnType<typeof mintedLog>[],
  options: {
    head: number;
    refuseAbove?: number;
    refuseAll?: boolean;
    /** A range that reaches below this block is refused (a node that gives up part of the way back). */
    refuseBelow?: number;
  },
): { from: number; to: number }[] {
  const asked: { from: number; to: number }[] = [];
  const eth = (
    window as unknown as {
      ethereum: { request: (a: unknown) => Promise<unknown> };
    }
  ).ethereum;
  const original = eth.request.bind(eth);
  eth.request = async (args: unknown) => {
    const { method, params } = args as { method: string; params?: unknown[] };
    if (method === "eth_blockNumber") return `0x${options.head.toString(16)}`;
    if (method === "eth_getLogs") {
      const p = params?.[0] as Params;
      const from = Number(BigInt(p.fromBlock));
      const to = Number(BigInt(p.toBlock));
      asked.push({ from, to });
      if (options.refuseAll)
        throw {
          code: -32005,
          message: "query returned more than 10000 results",
        };
      if (options.refuseBelow !== undefined && from < options.refuseBelow)
        throw { code: -32005, message: "block range not available" };
      if (
        options.refuseAbove !== undefined &&
        to - from + 1 > options.refuseAbove
      )
        throw { code: -32005, message: "block range too large" };
      return logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber));
        return b >= from && b <= to;
      });
    }
    return original(args);
  };
  return asked;
}
