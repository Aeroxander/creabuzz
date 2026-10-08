/**
 * The DAO launch as a resumable run: ask the kit where the executor will be, send the one transaction, read what it
 * made, save it to the launch record, publish the receipt.
 *
 * Only the transaction can spend money, and it happens once. Everything after it is bookkeeping that must not be
 * lost (Review-Proven Rule 1): the hash is stored the moment the wallet reports it mined, and every later step can
 * be retried, from this page or after a reload, without sending anything again.
 *
 * Pure: the chain, the record and the storage are injected, so `daoLaunchFlow.test.mjs` runs the real run against
 * fakes.
 */

import type { AuctionEffects } from "./auctionPlan.ts";
import {
  type DaoLaunchPlan,
  decodeKitLaunched,
  encodeKitLaunch,
  encodeKitPredictExecutor,
  type KitLaunched,
} from "./daoLaunch.ts";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Where a run stands. Pass the previous run's progress back in to resume it. */
export interface DaoLaunchProgress {
  /** The mined launch transaction, once there is one. */
  txHash: string | null;
  /** What that transaction made, once it was read. */
  launched: KitLaunched | null;
  /** The launch record carries the DAO, the Shares and the auction. */
  linked: boolean;
  /** The receipt is published. */
  published: boolean;
}

export const EMPTY_DAO_LAUNCH_PROGRESS: DaoLaunchProgress = {
  txHash: null,
  launched: null,
  linked: false,
  published: false,
};

export type DaoLaunchStep = "send" | "confirm" | "link" | "publish";

export interface DaoLaunchDeps {
  effects: Pick<AuctionEffects, "call" | "send" | "codeAt">;
  kit: string;
  plan: DaoLaunchPlan;
  /** Where the mined hash survives a reload. Blocked storage must not stop the launch. */
  txStore: {
    load(): string | null;
    save(txHash: string): void;
    clear(): void;
  };
  /** A mined launch's receipt, or null while the network has not reported one. */
  readReceipt(txHash: string): Promise<{
    status: "success" | "reverted";
    logs: readonly unknown[];
  } | null>;
  /** Save the DAO, its Shares and the auction on the launch record. Must reject on failure. */
  link(launched: KitLaunched): Promise<unknown>;
  /** Publish the receipt, bound to the transaction. Must reject on failure. */
  publish(launched: KitLaunched, txHash: string): Promise<unknown>;
  /** Called after each step lands, so a screen can show it. */
  onProgress?(progress: DaoLaunchProgress): void;
}

export type DaoLaunchOutcome =
  | { ok: true; progress: DaoLaunchProgress }
  | {
      ok: false;
      step: DaoLaunchStep;
      message: string;
      /** Whether pressing the button again could send the transaction a second time. Never true after it mined. */
      mayResend: boolean;
      progress: DaoLaunchProgress;
    };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The 20-byte answer of `predictExecutor` out of a 32-byte return word. */
function addressWord(result: string): string | null {
  const hex = result.replace(/^0x/, "");
  return hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex)
    ? `0x${hex.slice(24)}`.toLowerCase()
    : null;
}

/**
 * Run (or resume) a launch. Returns where it got to; it never throws, and never resends a transaction that already
 * mined.
 */
export async function runDaoLaunch(
  deps: DaoLaunchDeps,
  resume: DaoLaunchProgress = EMPTY_DAO_LAUNCH_PROGRESS,
): Promise<DaoLaunchOutcome> {
  let progress: DaoLaunchProgress = { ...resume };
  const update = (patch: Partial<DaoLaunchProgress>) => {
    progress = { ...progress, ...patch };
    deps.onProgress?.(progress);
  };
  const stop = (
    step: DaoLaunchStep,
    message: string,
    mayResend = false,
  ): DaoLaunchOutcome => ({ ok: false, step, message, mayResend, progress });

  // A hash stored by an earlier run of this page means the money step already happened.
  if (progress.txHash === null) {
    const stored = deps.txStore.load();
    if (stored !== null && TX_HASH_RE.test(stored)) update({ txHash: stored });
  }

  let logs: readonly unknown[] | null = null;

  // 1. The transaction, once.
  if (progress.txHash === null) {
    let data: string;
    try {
      const answer = await deps.effects.call({
        to: deps.kit,
        data: encodeKitPredictExecutor(deps.plan.salt),
      });
      const executor = addressWord(answer);
      if (executor === null) {
        return stop(
          "send",
          "The launch contract gave an unexpected answer. Check that this network has the launch contract.",
          true,
        );
      }
      // The salt is stable per launch on purpose: a second send of the same launch would collide with the first and
      // revert instead of creating a second DAO. Saying so here beats a failed transaction.
      if (await deps.effects.codeAt(executor)) {
        return stop(
          "send",
          "This launch has already created its DAO on this network, so it cannot be launched again. To raise again, start a new launch.",
        );
      }
      data = encodeKitLaunch(deps.plan, executor);
    } catch (error) {
      return stop(
        "send",
        `Could not prepare the launch: ${messageOf(error)}`,
        true,
      );
    }
    let receipt: Awaited<ReturnType<typeof deps.effects.send>>;
    try {
      receipt = await deps.effects.send({ to: deps.kit, data });
    } catch (error) {
      // A declined or timed-out send: the outcome is not known, so say so and let the founder look before retrying.
      return stop("send", messageOf(error), true);
    }
    if (receipt.status !== "success") {
      return stop(
        "send",
        "The network rejected the launch, so nothing was created. Nothing was spent beyond the network fee.",
        true,
      );
    }
    try {
      deps.txStore.save(receipt.txHash);
    } catch {
      // The run holds the hash in memory; only surviving a reload is lost.
    }
    logs = receipt.logs ?? null;
    update({ txHash: receipt.txHash });
  }

  // 2. What it made.
  if (progress.launched === null) {
    const txHash = progress.txHash as string;
    if (logs === null) {
      let found: Awaited<ReturnType<typeof deps.readReceipt>>;
      try {
        found = await deps.readReceipt(txHash);
      } catch (error) {
        return stop(
          "confirm",
          `Could not read the launch: ${messageOf(error)}`,
        );
      }
      if (found === null) {
        return stop(
          "confirm",
          "The network has not confirmed the launch yet. Try again in a moment.",
        );
      }
      if (found.status !== "success") {
        // The stored hash is a launch that never happened: forget it so the founder can start over.
        try {
          deps.txStore.clear();
        } catch {
          // Nothing to do: an unreadable store is read as empty.
        }
        update({ txHash: null });
        return stop(
          "confirm",
          "That launch was rejected by the network, so nothing was created. You can launch again.",
          true,
        );
      }
      logs = found.logs;
    }
    const launched = decodeKitLaunched(logs, deps.kit);
    if (launched === null) {
      return stop(
        "confirm",
        "The launch went through, but its result could not be read from the network's reply. Your hash is kept: try again, or look the transaction up on a block explorer.",
      );
    }
    if (launched.saleSupply !== deps.plan.saleSupply) {
      return stop(
        "confirm",
        "The launch on the network does not match the terms on this page, so it was not saved. Check the transaction on a block explorer.",
      );
    }
    update({ launched });
  }
  const launched = progress.launched as KitLaunched;
  const txHash = progress.txHash as string;

  // 3. The launch record.
  if (!progress.linked) {
    try {
      await deps.link(launched);
    } catch (error) {
      return stop(
        "link",
        `The DAO is live, but saving it to this launch failed: ${messageOf(error)} Retrying only saves it again; it never sends the money twice.`,
      );
    }
    update({ linked: true });
  }

  // 4. The receipt.
  if (!progress.published) {
    try {
      await deps.publish(launched, txHash);
    } catch (error) {
      return stop(
        "publish",
        `The DAO is live and saved, but publishing its receipt failed: ${messageOf(error)} Retrying only publishes it again.`,
      );
    }
    update({ published: true });
  }

  try {
    deps.txStore.clear();
  } catch {
    // A stale entry only offers a resume that finds everything done.
  }
  return { ok: true, progress };
}
