/**
 * Pure founder money-loop logic — FLOW half: the deploy state machine (reducer),
 * the retry plan, and the deploy orchestrator. The effect ports, constants,
 * parameter gate, config encoding and factory calls are in `auctionPlan.ts`
 * and re-exported from here, so this stays the one import site for the flow
 * (and the desktop test suite ports over byte-identical). See `auctionPlan.ts`
 * for the sources of truth every layout is checked against.
 */

export * from "./auctionPlan.ts";

import {
  buildBindAuctionCall,
  buildFundAuctionCall,
  buildOnTokensReceivedCall,
  buildSetHookAuctionCall,
  encodeErc20BalanceOf,
  SELECTOR_BOUND_AUCTION,
  SELECTOR_HOOK_AUCTION,
} from "./evmCalls.ts";
import {
  encodeAllowlistHookDeploy,
  encodeGraduationExecutorDeploy,
  predictCreateAddress,
} from "./graduationArtifact.ts";
import {
  addressWordValue,
  auctionErrorMessage,
  buildFactoryCreateCall,
  buildFactoryGetAddressView,
  DEFAULT_AUCTION_SALT,
  DEFAULT_CCA_FACTORY,
  DEFAULT_RESERVE_BPS,
  deriveAuctionDeployParams,
  encodeAuctionConfigData,
  type AuctionDeployParams,
  type AuctionEffects,
  type AuctionPlanInputs,
  type AuctionPreflightStage,
  type AuctionSendCall,
  type AuctionTxReceipt,
} from "./auctionPlan.ts";

// ---------------------------------------------------------------------------
// Deploy flow state machine (pure reducer)
// ---------------------------------------------------------------------------

/**
 * The onchain steps in hard order: the GraduationExecutor MUST precede the
 * auction (it is the auction's `fundsRecipient`/`tokensRecipient` at deploy
 * time — GraduationExecutor.sol:77-91). The hook (curated track) deploys first
 * because the auction constructor bakes its address in as `validationHook`.
 *
 * `AuctionLauncher.registerLaunch` is deliberately absent: OPTIONAL (its own
 * contract says the factory remains the deploy path, AuctionLauncher.sol:5-9)
 * and no launcher address is pinned in the record — deferred, reported.
 */
export const AUCTION_DEPLOY_STEPS = [
  {
    id: "hook",
    label: "Bid gate",
    detail: "Deploys the AllowlistHook (curated track only).",
  },
  {
    id: "executor",
    label: "Graduation executor",
    detail:
      "Deploys GraduationExecutor — the auction's funds/tokens recipient.",
  },
  {
    id: "auction",
    label: "Auction",
    detail: "Deploys the auction contract.",
  },
  {
    id: "hookAuction",
    label: "Lock bid gate to the auction",
    detail:
      "Tells the AllowlistHook which auction may call it, so nobody else can burn a bidder's cap (curated track only).",
  },
  {
    id: "fund",
    label: "Fund the auction",
    detail:
      "Transfers the whole sale supply from the deploying wallet to the auction.",
  },
  {
    id: "received",
    label: "Open bidding",
    detail:
      "Calls onTokensReceived() so the auction accepts bids. Safe to repeat.",
  },
  {
    id: "bind",
    label: "Bind the executor",
    detail:
      "Binds the graduation executor to this one auction — it refuses every other address.",
  },
] as const;

export type AuctionDeployStepId = (typeof AUCTION_DEPLOY_STEPS)[number]["id"];

export type AuctionDeployStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface AuctionDeployStepState {
  status: AuctionDeployStepStatus;
  /** Confirmed tx hash; null when satisfied by pre-existing code. */
  txHash: string | null;
  /** Created (CREATE) or precomputed (CREATE2) address. */
  address: string | null;
  /** Satisfied by code already onchain (an earlier attempt). */
  alreadyDeployed: boolean;
}

export type AuctionDeployPhase =
  | "idle"
  | "preparing"
  | "running"
  | "linking"
  | "success"
  | "paused"
  | "blocked";

export interface AuctionDeployFailure {
  /** Which part of the flow failed: preflight, an onchain step, the record update. */
  stage: "prepare" | "step" | "link";
  /** `stage: "prepare"` — which check. */
  check: AuctionPreflightStage | null;
  /** `stage: "step"` — which step. */
  step: AuctionDeployStepId | null;
  /** Mined tx hash (also present for a mined revert); null without a receipt. */
  txHash: string | null;
  /**
   * "reverted" — mined with status reverted; "unknown" — no receipt (the tx
   * may or may not have been broadcast); null — failed before broadcast.
   */
  outcome: "reverted" | "unknown" | null;
  reason: string;
}

export interface AuctionDeployState {
  phase: AuctionDeployPhase;
  steps: Record<AuctionDeployStepId, AuctionDeployStepState>;
  /** The CREATE2 auction address (known before the factory tx mines). */
  auctionAddress: string | null;
  failure: AuctionDeployFailure | null;
}

export type AuctionDeployAction =
  | { type: "begin"; mode: "fresh" | "resume" }
  | { type: "blocked"; stage: AuctionPreflightStage; detail: string }
  | { type: "prepared"; auctionAddress: string | null }
  | { type: "step_started"; step: AuctionDeployStepId }
  | { type: "step_address"; step: AuctionDeployStepId; address: string }
  | {
      type: "step_done";
      step: AuctionDeployStepId;
      txHash: string | null;
      address: string;
      alreadyDeployed: boolean;
    }
  | {
      type: "step_failed";
      step: AuctionDeployStepId;
      txHash: string | null;
      outcome: "reverted" | "unknown" | null;
      reason: string;
    }
  | { type: "link_started" }
  | { type: "link_failed"; reason: string }
  | { type: "linked" };

export type AuctionDispatch = (action: AuctionDeployAction) => void;

function freshDeploySteps(
  admission: "curated" | "community",
): Record<AuctionDeployStepId, AuctionDeployStepState> {
  const entry = (skipped: boolean): AuctionDeployStepState => ({
    status: skipped ? "skipped" : "pending",
    txHash: null,
    address: null,
    alreadyDeployed: false,
  });
  return {
    hook: entry(admission !== "curated"),
    executor: entry(false),
    auction: entry(false),
    hookAuction: entry(admission !== "curated"),
    fund: entry(false),
    received: entry(false),
    bind: entry(false),
  };
}

export function initAuctionDeployState(
  admission: "curated" | "community" = "community",
): AuctionDeployState {
  return {
    phase: "idle",
    steps: freshDeploySteps(admission),
    auctionAddress: null,
    failure: null,
  };
}

function withStep(
  state: AuctionDeployState,
  step: AuctionDeployStepId,
  patch: Partial<AuctionDeployStepState>,
): Record<AuctionDeployStepId, AuctionDeployStepState> {
  return { ...state.steps, [step]: { ...state.steps[step], ...patch } };
}

/** Pure flow reducer — the single state authority of the deploy card. */
export function auctionDeployReducer(
  state: AuctionDeployState,
  action: AuctionDeployAction,
): AuctionDeployState {
  switch (action.type) {
    case "begin": {
      // Both modes keep completed steps (deploy idempotency lives onchain plus
      // in the recorded predictions) and give a failed/running step a clean
      // retry that RETAINS its predicted address — the no-receipt guard reads
      // it before re-sending. `mode` documents intent ("fresh" = first run,
      // "resume" = retry); the transition is identical by design.
      const steps = Object.fromEntries(
        Object.entries(state.steps).map(([id, step]) => [
          id,
          step.status === "failed" || step.status === "running"
            ? {
                ...step,
                status: "pending" as const,
                txHash: null,
                alreadyDeployed: false,
              }
            : step,
        ]),
      ) as Record<AuctionDeployStepId, AuctionDeployStepState>;
      return { ...state, steps, phase: "preparing", failure: null };
    }
    case "blocked":
      return {
        ...state,
        phase: "blocked",
        failure: {
          stage: "prepare",
          check: action.stage,
          step: null,
          txHash: null,
          outcome: null,
          reason: action.detail,
        },
      };
    case "prepared":
      return {
        ...state,
        phase: "running",
        auctionAddress: action.auctionAddress ?? state.auctionAddress,
        failure: null,
      };
    case "step_started":
      return {
        ...state,
        phase: "running",
        steps: withStep(state, action.step, {
          status: "running",
          txHash: null,
          alreadyDeployed: false,
        }),
        failure: null,
      };
    case "step_address":
      return {
        ...state,
        steps: withStep(state, action.step, { address: action.address }),
      };
    case "step_done":
      return {
        ...state,
        steps: withStep(state, action.step, {
          status: "done",
          txHash: action.txHash,
          address: action.address,
          alreadyDeployed: action.alreadyDeployed,
        }),
      };
    case "step_failed":
      return {
        ...state,
        phase: "paused",
        steps: withStep(state, action.step, {
          status: "failed",
          txHash: action.txHash,
        }),
        failure: {
          stage: "step",
          check: null,
          step: action.step,
          txHash: action.txHash,
          outcome: action.outcome,
          reason: action.reason,
        },
      };
    case "link_started":
      return { ...state, phase: "linking", failure: null };
    case "link_failed":
      return {
        ...state,
        phase: "paused",
        failure: {
          stage: "link",
          check: null,
          step: null,
          txHash: null,
          outcome: null,
          reason: action.reason,
        },
      };
    case "linked":
      return { ...state, phase: "success", failure: null };
    default:
      return state;
  }
}

/** Index of the first step still to run (AUCTION_DEPLOY_STEPS.length when done). */
export function deployResumeIndex(state: AuctionDeployState): number {
  const index = AUCTION_DEPLOY_STEPS.findIndex(
    (s) =>
      state.steps[s.id].status !== "done" &&
      state.steps[s.id].status !== "skipped",
  );
  return index === -1 ? AUCTION_DEPLOY_STEPS.length : index;
}

/** What "retry" means in the current state (null = nothing to retry). */
export type AuctionRetryPlan =
  | { kind: "steps"; resumeAt: number }
  | { kind: "record"; auctionAddress: string }
  | null;

/**
 * Retry is always safe when offered:
 * - step failures resume at the failed step with RE-DERIVED inputs; a retry of
 *   a CREATE step first checks code at its predicted address (an unknown
 *   outcome is indistinguishable from "landed later"), and the factory step
 *   checks the CREATE2 address before re-sending (re-running `create` with the
 *   same salt would revert);
 * - the executor/hook CREATE retries predict a fresh address from the current
 *   nonce when no code exists at the previous prediction (a reverted deploy
 *   consumes its nonce);
 * - a record-update failure keeps the deployed auction and re-publishes only
 *   the record.
 */
export function retryPlan(state: AuctionDeployState): AuctionRetryPlan {
  if (state.phase !== "paused") return null;
  if (state.failure?.stage === "link") {
    const auctionAddress = state.auctionAddress ?? state.steps.auction.address;
    return auctionAddress ? { kind: "record", auctionAddress } : null;
  }
  if (state.failure?.stage === "step") {
    return { kind: "steps", resumeAt: deployResumeIndex(state) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deploy orchestrator
// ---------------------------------------------------------------------------

/** Labels for failure copy (rule 1: the failure names its step). */
export const AUCTION_DEPLOY_STEP_LABELS: Record<AuctionDeployStepId, string> = {
  hook: "Deploy bid gate",
  executor: "Deploy graduation executor",
  auction: "Deploy auction",
  hookAuction: "Lock bid gate to the auction",
  fund: "Fund the auction",
  received: "Open bidding",
  bind: "Bind the executor",
};

function isCreateStep(step: AuctionDeployStepId): step is "hook" | "executor" {
  return step === "hook" || step === "executor";
}

type PostDeployStepId = "hookAuction" | "fund" | "received" | "bind";

/** The 32-byte hex word as a bigint; an empty return (`0x`) reads as zero. */
function wordToBigInt(raw: string): bigint {
  return raw === "0x" || raw === "" ? 0n : BigInt(raw);
}

/**
 * Run one step that acts on the already-deployed contracts (lock the hook,
 * fund the auction, open bidding, bind the executor).
 *
 * Every step reads the chain first and is satisfied without a send when its
 * effect is already onchain, so a retry after an unknown outcome is always
 * safe (`onTokensReceived` is idempotent upstream). Returns whether the flow
 * may continue; on `false` the failure has already been dispatched.
 */
async function runPostDeployStep(input: {
  step: PostDeployStepId;
  effects: AuctionEffects;
  params: AuctionDeployParams;
  deployer: string;
  addresses: Record<AuctionDeployStepId, string | null>;
  dispatch: AuctionDispatch;
  fail: (
    step: AuctionDeployStepId,
    txHash: string | null,
    outcome: "reverted" | "unknown" | null,
    reason: string,
  ) => void;
}): Promise<boolean> {
  const { step, effects, params, deployer, addresses, dispatch, fail } = input;
  const auction = addresses.auction;
  if (!auction) {
    fail(
      step,
      null,
      null,
      "the auction address is unknown — run the auction step first",
    );
    return false;
  }
  const done = (address: string, txHash: string | null): void =>
    dispatch({
      type: "step_done",
      step,
      txHash,
      address,
      alreadyDeployed: txHash === null,
    });

  let call: AuctionSendCall;
  let target: string;
  try {
    switch (step) {
      case "hookAuction": {
        const hook = addresses.hook;
        if (!hook) {
          fail(
            step,
            null,
            null,
            "the bid gate address is unknown — run the bid gate step first",
          );
          return false;
        }
        const bound = addressWordValue(
          await effects.call({ to: hook, data: SELECTOR_HOOK_AUCTION }),
        );
        if (bound.toLowerCase() === auction.toLowerCase()) {
          done(hook, null);
          return true;
        }
        call = buildSetHookAuctionCall(hook, auction);
        target = hook;
        break;
      }
      case "fund": {
        const held = wordToBigInt(
          await effects.call({
            to: params.token,
            data: encodeErc20BalanceOf(auction),
          }),
        );
        if (held >= params.amount) {
          done(auction, null);
          return true;
        }
        const mine = wordToBigInt(
          await effects.call({
            to: params.token,
            data: encodeErc20BalanceOf(deployer),
          }),
        );
        if (mine < params.amount - held) {
          fail(
            step,
            null,
            null,
            `the deploying wallet ${deployer} holds ${mine} base units of the sale token but the auction still needs ${params.amount - held}: move the supply to this wallet, then retry`,
          );
          return false;
        }
        call = buildFundAuctionCall(
          params.token,
          auction,
          params.amount - held,
        );
        target = auction;
        break;
      }
      case "received":
        call = buildOnTokensReceivedCall(auction);
        target = auction;
        break;
      case "bind": {
        const executor = addresses.executor;
        if (!executor) {
          fail(
            step,
            null,
            null,
            "the GraduationExecutor address is unknown — run the executor step first",
          );
          return false;
        }
        const bound = addressWordValue(
          await effects.call({ to: executor, data: SELECTOR_BOUND_AUCTION }),
        );
        if (bound.toLowerCase() === auction.toLowerCase()) {
          done(executor, null);
          return true;
        }
        call = buildBindAuctionCall(executor, auction);
        target = executor;
        break;
      }
    }
  } catch (error) {
    fail(
      step,
      null,
      null,
      `reading the chain before "${AUCTION_DEPLOY_STEP_LABELS[step]}" failed: ${auctionErrorMessage(error)}`,
    );
    return false;
  }

  let receipt: AuctionTxReceipt;
  try {
    receipt = await effects.send(call);
  } catch (error) {
    fail(
      step,
      null,
      "unknown",
      `${auctionErrorMessage(error)} — the transaction may or may not have been broadcast; retry reads the chain first`,
    );
    return false;
  }
  if (receipt.status !== "success") {
    fail(
      step,
      receipt.txHash,
      "reverted",
      `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
    );
    return false;
  }
  done(target, receipt.txHash);
  return true;
}

/**
 * Run the deploy: optional hook CREATE → GraduationExecutor CREATE → factory
 * CREATE2 auction → (curated) lock the hook to the auction → fund the auction
 * with the sale supply → `onTokensReceived()` → bind the executor to the
 * auction → record link. Without the last four steps an auction cannot take a
 * bid (`TokensNotReceived`) and its executor would trust any address. Each receipt is awaited before the next
 * broadcast (the ordering is a hard protocol requirement — the executor must
 * exist before the auction names it as both recipients). Halts on the first
 * failure and records exactly which step failed and why (mined revert vs.
 * unknown outcome); completed steps are never rolled back or hidden.
 */
export async function runAuctionDeploy(input: {
  effects: AuctionEffects;
  plan: AuctionPlanInputs;
  deployer: string;
  factory?: string;
  reserveBps?: number;
  salt?: bigint;
  dispatch: AuctionDispatch;
  mode: "fresh" | "resume";
  /** The flow's current state — completed/predicted addresses seed retries. */
  previous: AuctionDeployState;
  /**
   * The auction address this launch was previously given — predicted by an
   * earlier attempt (persisted progress) or already recorded on the launch
   * record. The flow refuses to link a DIFFERENT address to the launch.
   */
  expectedAuction?: string | null;
  onLink: (input: { auction: string }) => Promise<unknown>;
}): Promise<void> {
  const {
    effects,
    plan,
    deployer,
    factory = DEFAULT_CCA_FACTORY,
    reserveBps = DEFAULT_RESERVE_BPS,
    salt = DEFAULT_AUCTION_SALT,
    dispatch,
    mode,
    previous,
    expectedAuction = null,
    onLink,
  } = input;

  const sameAddress = (a: string, b: string | null): boolean =>
    b !== null && a.toLowerCase() === b.toLowerCase();
  const mismatchReason = (kept: string, derived: string): string =>
    `this launch already carries auction ${kept}, but this deploy would link ${derived} — no transaction was sent. ` +
    `Reload and run the deploy again to confirm and resume ${kept} (an auction that exists onchain is never redeployed). ` +
    `If ${kept} belongs to a dead earlier attempt, relaunch the record first — that clears the old link — and then deploy.`;

  let params: AuctionDeployParams;
  try {
    params = deriveAuctionDeployParams(plan);
  } catch (error) {
    dispatch({
      type: "blocked",
      stage: "plan",
      detail: auctionErrorMessage(error),
    });
    return;
  }

  dispatch({ type: "begin", mode });
  dispatch({ type: "prepared", auctionAddress: null });

  // Re-link refusal: a launch that was previously predicted (persisted
  // progress) or recorded to one auction must never silently link a
  // different one. Checked HERE — before any effect runs — so a mismatch
  // costs nothing on chain and the founder gets a decision, not a surprise.
  const carriedAuction = previous.steps.auction.address;
  if (
    expectedAuction &&
    carriedAuction &&
    !sameAddress(expectedAuction, carriedAuction)
  ) {
    dispatch({
      type: "step_failed",
      step: "auction",
      txHash: null,
      outcome: null,
      reason: mismatchReason(expectedAuction, carriedAuction),
    });
    return;
  }
  // The address this launch already committed to (recorded wins over
  // predicted); the auction step refuses to link anything else.
  const guardedAuction = expectedAuction ?? carriedAuction;

  // Addresses as the run discovers them; seeded from the carried state so a
  // resume keeps earlier completions (and predictions) alive.
  const addresses: Record<AuctionDeployStepId, string | null> = {
    hook: previous.steps.hook.address,
    executor: previous.steps.executor.address,
    auction: previous.steps.auction.address,
    hookAuction: previous.steps.hookAuction.address,
    fund: previous.steps.fund.address,
    received: previous.steps.received.address,
    bind: previous.steps.bind.address,
  };

  const failStep = (
    step: AuctionDeployStepId,
    txHash: string | null,
    outcome: "reverted" | "unknown" | null,
    reason: string,
  ): void => {
    dispatch({ type: "step_failed", step, txHash, outcome, reason });
  };

  for (const { id: step } of AUCTION_DEPLOY_STEPS) {
    // The plan is authoritative: community-track launches deploy no hook even
    // if a stale state object says otherwise.
    if (
      (step === "hook" || step === "hookAuction") &&
      params.hookPerWalletCap === null
    )
      continue;
    const carried = previous.steps[step];
    if (carried.status === "done" || carried.status === "skipped") continue;
    dispatch({ type: "step_started", step });

    if (isCreateStep(step)) {
      // Idempotency guard (mintFlow's `tokenAlreadyDeployed`): code at the
      // predicted address means an earlier attempt's CREATE landed.
      if (carried.address) {
        let deployed: boolean;
        try {
          deployed = await effects.codeAt(carried.address);
        } catch (error) {
          failStep(
            step,
            null,
            null,
            `verifying ${carried.address} onchain failed: ${auctionErrorMessage(error)}`,
          );
          return;
        }
        if (deployed) {
          addresses[step] = carried.address;
          dispatch({
            type: "step_done",
            step,
            txHash: null,
            address: carried.address,
            alreadyDeployed: true,
          });
          continue;
        }
      }
      let nonce: bigint;
      try {
        nonce = await effects.transactionCount();
      } catch (error) {
        failStep(
          step,
          null,
          null,
          `reading the wallet nonce (for the deploy-address prediction) failed: ${auctionErrorMessage(error)}`,
        );
        return;
      }
      let predicted: string;
      try {
        predicted = predictCreateAddress(deployer, nonce);
      } catch (error) {
        failStep(step, null, null, auctionErrorMessage(error));
        return;
      }
      addresses[step] = predicted;
      dispatch({ type: "step_address", step, address: predicted });
      const data =
        step === "hook"
          ? encodeAllowlistHookDeploy(
              params.treasury,
              params.hookPerWalletCap ?? 0n,
            )
          : encodeGraduationExecutorDeploy(params.treasury, reserveBps);
      let receipt: AuctionTxReceipt;
      try {
        receipt = await effects.send({ data, value: "0x0" });
      } catch (error) {
        failStep(
          step,
          null,
          "unknown",
          `${auctionErrorMessage(error)} — the transaction may or may not have been broadcast; retry checks code at ${predicted} first`,
        );
        return;
      }
      if (receipt.status !== "success") {
        failStep(
          step,
          receipt.txHash,
          "reverted",
          `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
        );
        return;
      }
      // The receipt's `contractAddress` is authoritative for CREATE sends.
      const address = receipt.contractAddress ?? predicted;
      addresses[step] = address;
      dispatch({
        type: "step_done",
        step,
        txHash: receipt.txHash,
        address,
        alreadyDeployed: false,
      });
      continue;
    }

    if (step !== "auction") {
      // Acts on the deployed contracts; needs the auction address, which the
      // auction step (earlier in the list) has already recorded.
      const ok = await runPostDeployStep({
        step,
        effects,
        params,
        deployer,
        addresses,
        dispatch,
        fail: failStep,
      });
      if (!ok) return;
      continue;
    }

    // Auction step — factory CREATE2 with the executor as both recipients.
    const executor = addresses.executor;
    if (!executor) {
      failStep(
        step,
        null,
        null,
        "the GraduationExecutor address is unknown — run the executor step first",
      );
      return;
    }
    const configData = encodeAuctionConfigData({
      params,
      executor,
      hook: addresses.hook,
    });
    let auctionAddress: string | null = null;
    try {
      const raw = await effects.call(
        buildFactoryGetAddressView({
          factory,
          params,
          configData,
          salt,
          sender: deployer,
        }),
      );
      auctionAddress = addressWordValue(raw);
    } catch (error) {
      failStep(
        step,
        null,
        null,
        `factory.getAddress(...) failed: ${auctionErrorMessage(error)}`,
      );
      return;
    }
    // Re-link refusal / resume preference: the auction this launch already
    // carries (recorded or predicted earlier) wins over a re-derived one.
    // If it exists onchain it is confirmed and resumed — never deployed again
    // beside itself; if it does not and this run derives a different address,
    // refuse BEFORE the factory send, with a way out.
    if (guardedAuction && !sameAddress(guardedAuction, auctionAddress)) {
      let existing: boolean;
      try {
        existing = await effects.codeAt(guardedAuction);
      } catch (error) {
        failStep(
          step,
          null,
          null,
          `verifying ${guardedAuction} onchain failed: ${auctionErrorMessage(error)}`,
        );
        return;
      }
      if (existing) {
        addresses[step] = guardedAuction;
        dispatch({
          type: "step_done",
          step,
          txHash: null,
          address: guardedAuction,
          alreadyDeployed: true,
        });
        continue;
      }
      failStep(
        step,
        null,
        null,
        mismatchReason(guardedAuction, auctionAddress),
      );
      return;
    }
    addresses[step] = auctionAddress;
    dispatch({ type: "step_address", step, address: auctionAddress });
    try {
      if (await effects.codeAt(auctionAddress)) {
        dispatch({
          type: "step_done",
          step,
          txHash: null,
          address: auctionAddress,
          alreadyDeployed: true,
        });
        continue;
      }
    } catch (error) {
      failStep(
        step,
        null,
        null,
        `verifying ${auctionAddress} onchain failed: ${auctionErrorMessage(error)}`,
      );
      return;
    }
    let receipt: AuctionTxReceipt;
    try {
      receipt = await effects.send(
        buildFactoryCreateCall({ factory, params, configData, salt }),
      );
    } catch (error) {
      failStep(
        step,
        null,
        "unknown",
        `${auctionErrorMessage(error)} — the transaction may or may not have been broadcast; retry checks code at ${auctionAddress} first`,
      );
      return;
    }
    if (receipt.status !== "success") {
      failStep(
        step,
        receipt.txHash,
        "reverted",
        `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
      );
      return;
    }
    // Verify the factory actually created code where the CREATE2 said it would.
    try {
      const deployed = await effects.codeAt(auctionAddress);
      if (!deployed) {
        failStep(
          step,
          receipt.txHash,
          null,
          `the factory transaction ${receipt.txHash} confirmed but there is no code at ${auctionAddress} — retry re-checks before re-sending`,
        );
        return;
      }
    } catch (error) {
      failStep(
        step,
        receipt.txHash,
        null,
        `the factory transaction ${receipt.txHash} confirmed but verifying ${auctionAddress} failed: ${auctionErrorMessage(error)}`,
      );
      return;
    }
    dispatch({
      type: "step_done",
      step,
      txHash: receipt.txHash,
      address: auctionAddress,
      alreadyDeployed: false,
    });
  }

  const auctionAddress = addresses.auction;
  if (!auctionAddress) {
    failStep(
      "auction",
      null,
      null,
      "the auction address is unknown after the deploy steps",
    );
    return;
  }
  dispatch({ type: "prepared", auctionAddress });
  dispatch({ type: "link_started" });
  try {
    await onLink({ auction: auctionAddress });
  } catch (error) {
    dispatch({ type: "link_failed", reason: auctionErrorMessage(error) });
    return;
  }
  dispatch({ type: "linked" });
}
