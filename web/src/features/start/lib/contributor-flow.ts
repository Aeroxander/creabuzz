/**
 * Starting a contributor project, step by step: make it (the DAO, its first work budget and project, the transfer lock,
 * in one transaction), then publish it.
 *
 * The rules this keeps (the same as the other money flows, `step-flow.ts`):
 *
 * - each failure names its step and says why;
 * - a retry runs only the steps not yet done, and every step is safe to run twice. Before sending, the run asks the
 *   chain whether this project's DAO already exists at its predicted address (a reload, or an answer that never came
 *   back), so it never makes a second one. Publishing replaces the record with the same id;
 * - a transaction the chain reverted is a failure, never a success. When the kit refuses because another work budget
 *   was made at the same moment, nothing was made, and pressing again sends a fresh prediction.
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
import { actingErrorDetails } from "../../launchpad/lib/acting-account.ts";
import type { CreateLaunchInput } from "../../launchpad/use-launches.ts";
import {
  CALL_BUDGET_FACTORY,
  CALL_SHARES,
  CALL_SUMMONER,
  type ContributorDraft,
  contributorRecordInput,
  remixFromDraft,
  contributorTerms,
  createAddress,
  encodeKitLaunch,
  encodePredictDao,
  wordAddress,
} from "./contributor-project.ts";

export type ContributorStep = "create" | "record";

export const CONTRIBUTOR_STEPS: readonly ContributorStep[] = [
  "create",
  "record",
];

export const CONTRIBUTOR_STEP_LABELS: Record<ContributorStep, string> = {
  create: "Make the project: its DAO, first work budget and work areas",
  record: "Publish the project",
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
  /** 3 since a launch can have several first projects (D84); a stored 2 is read and converted. */
  version: 3;
  /** The founder's public key (the record's author). */
  author: string;
  launchId: string;
  /** The project's salt: with the founder's wallet, it fixes the DAO's address. */
  salt: string;
  chainId: number;
  /** The contributor kit. */
  kit: string;
  /** The launch kit's DAO factory, when this network has a launch kit: the contributor kit must use the same one. */
  expectedSummoner: string | null;
  /** The founder's wallet: the DAO's only holder at the start, and every first project's manager. */
  founder: string;
  /** The currency claims name for deposits (the network's USDC). */
  currency: string;
  draft: ContributorDraft;
  dao: string | null;
  shares: string | null;
  createTx: string | null;
  recorded: boolean;
}

export interface ContributorEffects {
  /** An `eth_call`'s raw answer. */
  call(to: string, data: string): Promise<string>;
  /** Whether an address has code. */
  codeAt(address: string): Promise<boolean>;
  /** How many contracts an address has made (its nonce). */
  nonceOf(address: string): Promise<bigint>;
  /** Send one transaction from the founder's wallet and wait for its receipt. */
  send(
    to: string,
    data: string,
  ): Promise<{ txHash: string; status: "success" | "reverted" }>;
  /** The latest block's timestamp. */
  now(): Promise<number>;
  /** Wait `ms` before asking the network again (`setTimeout` on the page; immediate in tests). */
  wait?(ms: number): Promise<void>;
  /** Publish the project's record; must throw when the server refuses it. */
  publish(input: CreateLaunchInput): Promise<void>;
  /** Keep the job (local storage on the page). */
  save(job: ContributorJob): void;
}

export type ContributorOutcome =
  | { ok: true; job: ContributorJob }
  | {
      ok: false;
      job: ContributorJob;
      step: ContributorStep;
      message: string;
      /** The failure's original text, for "Technical details"; null when the message is all there is. */
      technical: string | null;
    };

/**
 * How many times, and how far apart, the page's own network is asked for the new DAO after the send is confirmed. The
 * confirmation comes from a different node (a passkey step's from the fee service's), so the page's node can be a block
 * or two behind: about ten seconds covers that without keeping the founder waiting on a real failure.
 */
export const DAO_CODE_TRIES = 5;
export const DAO_CODE_WAIT_MS = 2_000;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether the DAO shows on the page's node, asking a bounded number of times. */
async function daoShows(dao: string, fx: ContributorEffects): Promise<boolean> {
  const wait = fx.wait ?? pause;
  for (let attempt = 0; attempt < DAO_CODE_TRIES; attempt += 1) {
    if (await fx.codeAt(dao)) return true;
    if (attempt + 1 < DAO_CODE_TRIES) await wait(DAO_CODE_WAIT_MS);
  }
  return false;
}

/** Which steps a job has already done, for a page that opens on a job from an earlier visit. */
export function doneSteps(job: ContributorJob): Set<ContributorStep> {
  const done = new Set<ContributorStep>();
  if (job.dao && job.shares) done.add("create");
  if (job.recorded) done.add("record");
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

async function makeProject(
  job: ContributorJob,
  fx: ContributorEffects,
): Promise<ContributorJob> {
  const terms = contributorTerms(job.draft, job.founder);
  const dao = wordAddress(
    await fx.call(
      job.kit,
      encodePredictDao(job.founder, terms.founderWhole, job.salt),
    ),
  );
  let createTx = job.createTx;
  // Made already (a reload, or a send whose answer was lost)? Then use it: the address is this wallet's own.
  if (!(await fx.codeAt(dao))) {
    const summoner = wordAddress(await fx.call(job.kit, CALL_SUMMONER));
    if (job.expectedSummoner && summoner !== job.expectedSummoner.toLowerCase())
      throw new Error(
        "this network's contributor kit makes a different kind of DAO from the one the app reads. Nothing was sent.",
      );
    const factory = wordAddress(await fx.call(job.kit, CALL_BUDGET_FACTORY));
    const sent = await fx.send(
      job.kit,
      encodeKitLaunch({
        terms,
        salt: job.salt,
        founder: job.founder,
        currency: job.currency,
        predictedBudget: createAddress(factory, await fx.nonceOf(factory)),
        now: await fx.now(),
      }),
    );
    createTx = sent.txHash;
    if (sent.status !== "success")
      throw new Error(
        "the network turned the transaction down, so nothing was made. Most often another project was being set up at the same moment: try again.",
      );
    if (!(await daoShows(dao, fx)))
      throw new Error(
        `it was sent and confirmed (${sent.txHash}), but this site's view of the network does not show the DAO yet. Press Try again in a minute: it picks up the DAO once it shows, and never makes a second one.`,
      );
  }
  const shares = wordAddress(await fx.call(dao, CALL_SHARES));
  return { ...job, dao, shares, createTx };
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
      if (step === "create") job = await makeProject(job, fx);
      if (step === "record") {
        await fx.publish(
          contributorRecordInput({
            launchId: job.launchId,
            terms: contributorTerms(job.draft, job.founder),
            chainId: job.chainId,
            dao: job.dao as string,
            shares: job.shares as string,
            currency: job.currency,
            remix: remixFromDraft(job.draft),
          }),
        );
        job = { ...job, recorded: true };
      }
    } catch (error) {
      fx.save(job);
      dispatch({ type: "step-failed", step, message: message(error) });
      return {
        ok: false,
        job,
        step,
        message: message(error),
        technical: actingErrorDetails(error),
      };
    }
    fx.save(job);
    dispatch({ type: "step-done", step });
  }
  return { ok: true, job };
}

// ---- keeping the job between visits ------------------------------------------------------------

export const JOB_STORAGE_PREFIX = "creaton.contributor-start.";

/** A stored job, or null when there is none or it is not one this app wrote. A job from before D84 (one first project)
 * is converted, so a start cut short by an update can still be finished. */
export function parseJob(raw: string | null): ContributorJob | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Omit<
      Partial<ContributorJob>,
      "version"
    > & {
      version?: number;
    };
    if (
      (value?.version !== 2 && value?.version !== 3) ||
      typeof value.launchId !== "string" ||
      typeof value.salt !== "string" ||
      typeof value.kit !== "string" ||
      typeof value.founder !== "string" ||
      typeof value.draft !== "object" ||
      value.draft === null
    )
      return null;
    const draft = value.draft as ContributorDraft & {
      projectName?: unknown;
      projectCheck?: unknown;
    };
    if (!Array.isArray(draft.projects)) {
      if (
        typeof draft.projectName !== "string" ||
        typeof draft.projectCheck !== "string"
      )
        return null;
      const { projectName, projectCheck, ...rest } = draft;
      value.draft = {
        ...rest,
        projects: [
          { name: projectName, check: projectCheck, shares: draft.projectCap },
        ],
      };
    }
    return { ...value, version: 3 } as ContributorJob;
  } catch {
    return null;
  }
}
