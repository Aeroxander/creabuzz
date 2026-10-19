/**
 * Starting a contributor project, step by step: make the DAO, publish the project, open its first work budget.
 *
 * The rules this keeps (the same as the other money flows, `step-flow.ts`):
 *
 * - each failure names its step and says why;
 * - a retry runs only the steps not yet done, and every step is safe to run twice. Making the DAO first asks the
 *   chain whether this project's key already has one (and whose it is), so a reload never makes a second DAO.
 *   Publishing the record replaces the record with the same id. The first decision is opened with a fixed nonce, and
 *   the DAO treats opening an open decision as nothing to do;
 * - a transaction the chain reverted is a failure, never a success.
 *
 * Everything the run learns is kept in the job (`save`), so the page can pick it up after a reload.
 *
 * Alias-free: `contributor-flow.test.mjs` drives it with a fake chain.
 */

import {
  createStepFlow,
  type StepFlowAction,
  type StepFlowState,
} from "@creaton/core/launchpad/step-flow.ts";
import type { CreateLaunchInput } from "../../launchpad/use-launches.ts";
import { encodeOpenProposalWithAction } from "../../launchpad/lib/vote-tx.ts";
import {
  CALL_GET_IMPLEMENTATION,
  CALL_MANDATE_FACTORY,
  CALL_SHARES,
  CALL_SUMMONER,
  CALL_VOTING_WEIGHT,
  type ContributorDraft,
  contributorRecordInput,
  contributorTerms,
  daoFromReceiptLogs,
  encodeBinderOf,
  encodeBindingOf,
  encodeSummonAndBind,
  firstBudgetDecision,
  firstBudgetNonce,
  wordAddress,
  ZERO_ADDRESS,
} from "./contributor-project.ts";

export type ContributorStep = "create" | "record" | "budget";

export const CONTRIBUTOR_STEPS: readonly ContributorStep[] = [
  "create",
  "record",
  "budget",
];

export const CONTRIBUTOR_STEP_LABELS: Record<ContributorStep, string> = {
  create: "Make the project's DAO",
  record: "Publish the project",
  budget: "Open the first work budget for a vote",
};

const flow = createStepFlow<ContributorStep, never>(
  CONTRIBUTOR_STEPS,
  CONTRIBUTOR_STEP_LABELS,
);
export const contributorFlow = flow;
export type ContributorFlowState = StepFlowState<ContributorStep, never>;
export type ContributorFlowAction = StepFlowAction<ContributorStep, never>;

/** Everything a run knows, kept between visits. */
export interface ContributorJob {
  version: 1;
  /** The founder's public key (the record's author). */
  author: string;
  launchId: string;
  rootId: string;
  chainId: number;
  /** The DAO maker. */
  binding: string;
  /** The launch kit's DAO factory, when this network has a kit: the DAO maker must use the same one. */
  expectedSummoner: string | null;
  /** The founder's wallet: the DAO's only holder at the start. */
  founder: string;
  /** The currency claims name for deposits (the network's USDC). */
  currency: string;
  currencyDecimals: number;
  draft: ContributorDraft;
  dao: string | null;
  shares: string | null;
  createTx: string | null;
  recorded: boolean;
  /** The first decision as it was first sent, so a retry sends the very same one. */
  budget: { to: string; data: string; nonce: string; title: string } | null;
  budgetTx: string | null;
  budgetOpened: boolean;
}

export interface ContributorEffects {
  /** An `eth_call`'s raw answer. */
  call(to: string, data: string): Promise<string>;
  /** Send one transaction from the founder's wallet and wait for its receipt. */
  send(
    to: string,
    data: string,
  ): Promise<{
    txHash: string;
    status: "success" | "reverted";
    logs: readonly { address?: string; topics?: readonly string[] }[];
  }>;
  /** The latest block's timestamp. */
  now(): Promise<number>;
  /** Publish the project's record; must throw when the server refuses it. */
  publish(input: CreateLaunchInput): Promise<void>;
  /** Keep the job (local storage on the page). */
  save(job: ContributorJob): void;
}

export type ContributorOutcome =
  | { ok: true; job: ContributorJob }
  | { ok: false; job: ContributorJob; step: ContributorStep; message: string };

/** Which steps a job has already done, for a page that opens on a job from an earlier visit. */
export function doneSteps(job: ContributorJob): Set<ContributorStep> {
  const done = new Set<ContributorStep>();
  if (job.dao && job.shares) done.add("create");
  if (job.recorded) done.add("record");
  if (job.budgetOpened) done.add("budget");
  return done;
}

/** The step-flow state for a job: its done steps marked, the rest pending. */
export function stateForJob(job: ContributorJob): ContributorFlowState {
  let state = flow.reducer(flow.initial(), {
    type: "reset",
    order: CONTRIBUTOR_STEPS,
  });
  for (const step of doneSteps(job)) {
    state = flow.reducer(state, { type: "step-done", step });
  }
  return state;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isZero = (address: string) => address === ZERO_ADDRESS;

async function makeDao(
  job: ContributorJob,
  fx: ContributorEffects,
): Promise<ContributorJob> {
  const terms = contributorTerms(job.draft, job.founder);
  // Already made (a reload, or a send whose answer was lost)? Then it is this project's only if this wallet made it.
  let dao = wordAddress(
    await fx.call(job.binding, encodeBindingOf(job.rootId)),
  );
  let createTx = job.createTx;
  if (isZero(dao)) {
    const summoner = wordAddress(await fx.call(job.binding, CALL_SUMMONER));
    if (job.expectedSummoner && summoner !== job.expectedSummoner.toLowerCase())
      throw new Error(
        "This network's DAO maker makes a different kind of DAO from the one the app reads. Nothing was sent.",
      );
    const molochImpl = wordAddress(
      await fx.call(summoner, CALL_GET_IMPLEMENTATION),
    );
    const sent = await fx.send(
      job.binding,
      encodeSummonAndBind({
        rootId: job.rootId,
        name: terms.name,
        symbol: terms.symbol,
        molochImpl,
        founder: job.founder,
        founderWhole: terms.founderWhole,
      }),
    );
    createTx = sent.txHash;
    if (sent.status !== "success")
      throw new Error(
        `the network turned the transaction down (${sent.txHash}). Nothing was made.`,
      );
    dao =
      daoFromReceiptLogs(sent.logs, job.binding, job.rootId) ??
      wordAddress(await fx.call(job.binding, encodeBindingOf(job.rootId)));
    if (isZero(dao))
      throw new Error(
        `the transaction went through (${sent.txHash}) but no DAO is filed for this project. Check it before trying again.`,
      );
  } else {
    const binder = wordAddress(
      await fx.call(job.binding, encodeBinderOf(job.rootId)),
    );
    if (binder !== job.founder.toLowerCase())
      throw new Error(
        "another wallet already made a DAO under this project's name. Start it under a different name.",
      );
  }
  const shares = wordAddress(await fx.call(dao, CALL_SHARES));
  return { ...job, dao, shares, createTx };
}

/** Compose the first decision once; a job that has one keeps it, so every send is the very same decision. */
async function composeBudget(
  job: ContributorJob,
  fx: ContributorEffects,
): Promise<ContributorJob> {
  if (job.budget) return job;
  const dao = job.dao as string;
  const policy = wordAddress(await fx.call(dao, CALL_VOTING_WEIGHT));
  const factory = wordAddress(await fx.call(policy, CALL_MANDATE_FACTORY));
  const decision = firstBudgetDecision({
    terms: contributorTerms(job.draft, job.founder),
    dao,
    factory,
    currency: job.currency,
    currencyDecimals: job.currencyDecimals,
    now: await fx.now(),
  });
  return {
    ...job,
    budget: {
      to: decision.to,
      data: decision.data,
      nonce: firstBudgetNonce(job.rootId),
      title: decision.title,
    },
  };
}

async function openBudget(
  job: ContributorJob,
  fx: ContributorEffects,
): Promise<ContributorJob> {
  const dao = job.dao as string;
  const budget = job.budget as NonNullable<ContributorJob["budget"]>;
  const sent = await fx.send(
    dao,
    encodeOpenProposalWithAction({
      op: 0,
      to: budget.to,
      value: 0n,
      data: budget.data,
      nonce: budget.nonce,
    }),
  );
  if (sent.status !== "success")
    throw new Error(
      `the network turned the transaction down (${sent.txHash}). The DAO and the project exist; try opening the work budget again.`,
    );
  return { ...job, budgetTx: sent.txHash, budgetOpened: true };
}

/**
 * Run every step the job has not done, in order, stopping at the first failure. `dispatch` follows the steps for the
 * page; the job is saved after each one.
 */
export async function runContributorStart(
  start: ContributorJob,
  fx: ContributorEffects,
  dispatch: (action: ContributorFlowAction) => void,
): Promise<ContributorOutcome> {
  let job = start;
  const done = doneSteps(job);
  for (const step of CONTRIBUTOR_STEPS) {
    if (done.has(step)) continue;
    dispatch({ type: "step-start", step });
    try {
      if (step === "create") job = await makeDao(job, fx);
      if (step === "record") {
        await fx.publish(
          contributorRecordInput({
            launchId: job.launchId,
            terms: contributorTerms(job.draft, job.founder),
            chainId: job.chainId,
            dao: job.dao as string,
            shares: job.shares as string,
            currency: job.currency,
          }),
        );
        job = { ...job, recorded: true };
      }
      if (step === "budget") {
        // Kept before it is sent: a retry must send exactly this decision, not one recomposed at a later time.
        job = await composeBudget(job, fx);
        fx.save(job);
        job = await openBudget(job, fx);
      }
    } catch (error) {
      fx.save(job);
      dispatch({ type: "step-failed", step, message: message(error) });
      return { ok: false, job, step, message: message(error) };
    }
    fx.save(job);
    dispatch({ type: "step-done", step });
  }
  return { ok: true, job };
}

// ---- keeping the job between visits ------------------------------------------------------------

export const JOB_STORAGE_PREFIX = "creaton.contributor-start.";

/** A stored job, or null when there is none or it is not one this version wrote. */
export function parseJob(raw: string | null): ContributorJob | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ContributorJob>;
    if (
      value?.version !== 1 ||
      typeof value.launchId !== "string" ||
      typeof value.rootId !== "string" ||
      typeof value.binding !== "string" ||
      typeof value.founder !== "string" ||
      typeof value.draft !== "object" ||
      value.draft === null
    )
      return null;
    return value as ContributorJob;
  } catch {
    return null;
  }
}
