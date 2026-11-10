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
import {
  type ChainEnv,
  contributorKit,
  testQuoteToken,
  viteEnv,
} from "../../launchpad/chain-config.ts";
import { actingErrorDetails } from "../../launchpad/lib/acting-account.ts";
import { tradingOffered } from "../../launchpad/lib/trading-offered.ts";
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
import {
  assertLaunchFits,
  encodeKitLaunchV2,
  encodePredictLaunch,
  weeklySaleTerms,
} from "./weekly-sale.ts";

export type ContributorStep = "create" | "record";

export const CONTRIBUTOR_STEPS: readonly ContributorStep[] = [
  "create",
  "record",
];

export const CONTRIBUTOR_STEP_LABELS: Record<ContributorStep, string> = {
  create:
    "Make the project: its shared money and rules, first work budget and work areas",
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
  /**
   * The community (its server's address) the project was started in: its board and record belong there. Absent on a
   * job kept before it was recorded.
   */
  relay?: string;
  launchId: string;
  /** The project's salt: with the founder's wallet, it fixes the DAO's address. */
  salt: string;
  /**
   * This try's own random part of the salt, made when the try began and kept only here. Two tries at the same project
   * (the first one discarded, or begun in another browser) therefore never predict the same address, so a second try
   * with other reviewers or work areas cannot land on, and publish over, the first try's DAO. Absent on a job kept
   * before tries had one: its salt follows from the project's id alone.
   */
  attempt?: string;
  chainId: number;
  /** The contributor kit. */
  kit: string;
  /** The launch kit's DAO factory, when this network has a launch kit: the contributor kit must use the same one. */
  expectedSummoner: string | null;
  /** The founder's wallet: the DAO's only holder at the start, and every first project's manager. */
  founder: string;
  /** The currency claims name for deposits (the network's USDC). */
  currency: string;
  /**
   * Set when the kit is the weekly-sale kit (`weekly-sale.ts`): the price token its market is made for. The sale's lot
   * and schedule are the draft's. Absent for the plain kit, whose launch has none of it.
   */
  weekly?: { quote: string };
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
  /**
   * Whether this kit itself summoned the DAO at `dao` (the DAO factory logged it as made by the kit). Anyone can summon
   * a DAO at an address worked out from public values, so code at the address is not proof it is this project's.
   */
  madeByKit(kit: string, dao: string): Promise<boolean>;
  /** How many contracts an address has made (its nonce). */
  nonceOf(address: string): Promise<bigint>;
  /**
   * What the node says `data` sent from `from` to `to` would use, asked live. Used only for the weekly-sale launch, which
   * is large enough to be asked about first; a node that refuses or does not answer rejects.
   */
  estimateGas(from: string, to: string, data: string): Promise<bigint>;
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
  /** The build's settings, for the check that a stored weekly job is still offered; the page leaves it out. */
  env?: ChainEnv;
}

/** Said when a project already exists at a try's address and the try cannot be shown to have made it. */
export const EARLIER_TRY_MESSAGE =
  "A project was already made at this address in an earlier try, and we can't tell whether it was set up with what you entered here. Nothing was sent. Discard this and start the project again: the new try gets a new address.";

const WEEKLY_NOT_OFFERED_MESSAGE =
  "This site no longer offers trading with the project maker and trade token this half-finished project was set up with, so nothing was sent. Discard it and start the project again.";

/**
 * Whether this build still offers the weekly-sale launch a stored job asked for: trading is on, the kit is the one the
 * build names, and the price token is the build's test token. A job outlives a rebuild of the site (same address, same
 * browser storage), so it is asked again before anything is sent.
 */
function weeklyStillOffered(job: ContributorJob, env: ChainEnv | undefined) {
  if (!job.weekly) return true;
  return (
    tradingOffered(env) &&
    contributorKit(job.chainId, env) === job.kit.toLowerCase() &&
    testQuoteToken(job.chainId, env) === job.weekly.quote.toLowerCase()
  );
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

/**
 * Whether the kit made the DAO, asking a bounded number of times. The log index can trail the code on a node that is a
 * block behind, so a clean "no" is asked again before it is believed. A node error is not a "no": it propagates.
 */
async function kitMadeIt(
  kit: string,
  dao: string,
  fx: ContributorEffects,
): Promise<boolean> {
  const wait = fx.wait ?? pause;
  for (let attempt = 0; attempt < DAO_CODE_TRIES; attempt += 1) {
    if (await fx.madeByKit(kit, dao)) return true;
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
  /** Called as soon as a send has gone through, before anything else can fail: the job then has its send on record. */
  onSent: (job: ContributorJob) => void,
): Promise<ContributorJob> {
  const terms = contributorTerms(job.draft, job.founder, { resumed: true });
  // The weekly-sale kit's DAO is predicted with its market (`predictLaunch`, the DAO first in its answer), from the sale
  // fields the draft holds; a draft whose sale fields no longer make sense stops here, before anything is read or sent.
  const weekly = job.weekly
    ? {
        quote: job.weekly.quote,
        sale: weeklySaleTerms(job.draft, terms.founderWhole),
      }
    : null;
  const dao = wordAddress(
    await fx.call(
      job.kit,
      weekly
        ? encodePredictLaunch(
            job.founder,
            terms.founderWhole,
            job.salt,
            weekly.quote,
            weekly.sale.lotSize,
          )
        : encodePredictDao(job.founder, terms.founderWhole, job.salt),
    ),
  );
  let createTx = job.createTx;
  // Made already (a reload, or a send whose answer was lost)? Then use it, but only when the kit made it: the address
  // follows from public values, so someone else could have summoned a DAO of their own there first. Adopting that one
  // would publish a project whose DAO the founder does not control. Nothing is sent or published for it.
  if (await fx.codeAt(dao)) {
    // A try with its own salt and no send on record: the only send that could have made this is this try's own, whose
    // answer was lost, with this try's own words. A try from before salts were per try is different: its address
    // follows from the project's id, so the DAO there may be an earlier, discarded try's, set up with other reviewers
    // and work areas. That one is never adopted: the words in this form would be published over a DAO they do not
    // describe. A try whose own send is on record (kept the moment the send went through, see below) is carried on
    // whichever kind it is: that send is what made the DAO.
    if (!job.attempt && !job.createTx) throw new Error(EARLIER_TRY_MESSAGE);
    if (!(await kitMadeIt(job.kit, dao, fx)))
      throw new Error(
        "We could not confirm that this project was made at the address we expect. Nothing was sent. If you started this project a moment ago, press Try again in a minute. Otherwise discard it and start the project again: it then gets a new address.",
      );
  } else {
    // Only before a send: a project already made must still reach its record, whatever this build offers now.
    if (!weeklyStillOffered(job, fx.env ?? viteEnv()))
      throw new Error(WEEKLY_NOT_OFFERED_MESSAGE);
    const summoner = wordAddress(await fx.call(job.kit, CALL_SUMMONER));
    if (job.expectedSummoner && summoner !== job.expectedSummoner.toLowerCase())
      throw new Error(
        "This network makes a different kind of project from the one this app reads. Nothing was sent.",
      );
    const factory = wordAddress(await fx.call(job.kit, CALL_BUDGET_FACTORY));
    const launch = {
      terms,
      salt: job.salt,
      founder: job.founder,
      currency: job.currency,
      predictedBudget: createAddress(factory, await fx.nonceOf(factory)),
      now: await fx.now(),
    };
    const data = weekly
      ? encodeKitLaunchV2({ ...launch, ...weekly })
      : encodeKitLaunch(launch);
    // The weekly launch is large (about 10.8 million against a limit of 16.8 million): the node is asked what it needs
    // first, live, and a refusal, a launch over the limit or no answer ends here in plain words with nothing sent.
    if (weekly)
      await assertLaunchFits(() => fx.estimateGas(job.founder, job.kit, data));
    const sent = await fx.send(job.kit, data);
    if (sent.status !== "success")
      throw new Error(
        "The network turned the request down, so nothing was made. Most often another project was being set up at the same moment. Try again.",
      );
    // The send went through: that is put on record now, before the node is asked whether it shows the project. If the
    // node is a moment behind and this step stops, pressing again knows this try's own send made what is there.
    createTx = sent.txHash;
    onSent({ ...job, createTx });
    if (!(await daoShows(dao, fx)))
      throw new Error(
        `Your request went through (confirmation ${sent.txHash}), but this site cannot see the new project on the network yet. Press Try again in a minute: it picks the project up once it shows, and never makes a second one.`,
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
      if (step === "create")
        job = await makeProject(job, fx, (sent) => {
          job = sent;
          fx.save(sent);
        });
      if (step === "record") {
        await fx.publish(
          contributorRecordInput({
            launchId: job.launchId,
            terms: contributorTerms(job.draft, job.founder, {
              resumed: true,
            }),
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

/**
 * The scope the project's board is remembered under while its record is not saved yet: the community the job was
 * started in, its founder and its project. A job kept before the community was recorded takes the one open now.
 */
export function jobBoardScope(
  job: ContributorJob,
  currentRelay: string,
): { relay: string; founder: string; launchId: string } {
  return {
    relay: job.relay ?? currentRelay,
    founder: job.author,
    launchId: job.launchId,
  };
}

/**
 * A project's record and board go to the community it was started in. After a switch to another one, publishing would
 * put them in the wrong place, so the step stops and says how to finish.
 */
export function assertJobCommunity(
  scope: { relay: string },
  currentRelay: string,
): void {
  if (scope.relay !== currentRelay) {
    throw new Error(
      "This project was started in another community. Switch back to it, then press Try again.",
    );
  }
}

// ---- keeping the job between visits ------------------------------------------------------------

export const JOB_STORAGE_PREFIX = "creaton.contributor-start.";

/** A stored job's weekly-sale part is absent, or names a price token: anything else would send the wrong launch. */
function weeklyJobOk(weekly: unknown): boolean {
  if (weekly === undefined) return true;
  const quote = (weekly as { quote?: unknown } | null)?.quote;
  return typeof quote === "string" && /^0x[0-9a-fA-F]{40}$/.test(quote);
}

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
      (value.relay !== undefined && typeof value.relay !== "string") ||
      !weeklyJobOk(value.weekly) ||
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
    // A try's own part of the salt is 32 hex characters. Anything else is not one: the job is then read as a try
    // without its own part, which is never allowed to adopt a project it has no send on record for.
    if (
      typeof value.attempt !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.attempt)
    )
      delete value.attempt;
    return { ...value, version: 3 } as ContributorJob;
  } catch {
    return null;
  }
}
