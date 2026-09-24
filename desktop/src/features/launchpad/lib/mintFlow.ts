/**
 * Pure deploy-flow logic for the Manage panel's one-click apptoken deploy.
 *
 * No network, clock, or DOM access: the orchestrators talk to the chain only
 * through the injected {@link MintEffects} ports (wired to the Tauri
 * `evm_call` / `evm_send_transaction` IPC commands in `mintHooks.ts`), and the
 * visible flow state is the pure {@link mintFlowReducer} — so
 * `mintFlow.test.mjs` binds this exact production seam with `cast`-generated
 * calldata goldens and scripted fakes.
 *
 * The two VIEW preconditions mirror `contracts/script/DeployAppToken.s.sol`
 * (`router.infrastructureFeeBPS()` +
 * `factory.computeDeploymentAddress(...)`); their results feed
 * `buildTokenDeployCalls` as `tokenAddress` / fee inputs, exactly as the
 * script passes them:
 * - `infrastructureFeeBPS() -> uint16`: `IRouterInfraFee` in
 *   `contracts/script/DeployAppToken.s.sol`; public state var in
 *   `contracts/lib/tm-tokenmaster/src/TokenMasterRouter.sol`.
 * - `computeDeploymentAddress(bytes32,(string,string,uint8,address,address,
 *   uint256,bytes,address,bool,address,uint256),uint256,uint256) -> address`:
 *   `contracts/lib/tm-tokenmaster/src/interfaces/ITokenMasterFactory.sol`;
 *   `PoolDeploymentParameters` field order from `.../src/DataTypes.sol`.
 * Both selectors are pinned against `cast sig` in `mintFlow.test.mjs`.
 */

import { decodeUint256 } from "@/features/launchpad/lib/chainRpc";
import {
  buildTokenDeployCalls,
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  encodeDeployToken,
  encodeFunctionData,
  selectorOf,
  ZERO_ADDRESS,
  type EvmCall,
  type TokenDeployCallsParams,
} from "@/features/launchpad/lib/evmCalls";

// ---------------------------------------------------------------------------
// Effect ports (the Tauri IPC surface, injected for testability)
// ---------------------------------------------------------------------------

/** Receipt shape of `evm_send_transaction` (the IPC contract). */
export interface MintTxReceipt {
  txHash: string;
  status: "success" | "reverted";
  blockNumber: number;
  gasUsed: string;
  contractAddress: string | null;
}

/**
 * The chain effects the deploy flow needs. A mined `status: "reverted"` is
 * DATA (a failed step), not an exception; a rejected `send` means the outcome
 * is unknown (possibly never broadcast) and is reported as such.
 */
export interface MintEffects {
  /** `evm_call` — returns raw hex return data (a single 32-byte word here). */
  call(target: { to: string; data: string }): Promise<string>;
  /** `evm_send_transaction` — resolves once the transaction is mined. */
  send(call: EvmCall): Promise<MintTxReceipt>;
}

/** Human-safe message for a thrown unknown. */
export function mintErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Plan inputs -> deploy params
// ---------------------------------------------------------------------------

/** The launch's mint plan plus the v1 deployer-derived treasury. */
export interface MintPlanInputs {
  /** `PoolDeploymentParameters.name` (the launch record's token plan). */
  name: string;
  /** `PoolDeploymentParameters.symbol`. */
  symbol: string;
  /** Whole tokens (the plan's supply); converted to 18-decimal base units. */
  supply: string;
  /**
   * Token `initialOwner` AND `initialSupplyRecipient`. V1: the deployer
   * wallet — calls 2-3 (`setTransferValidator`, `setRulesetOfCollection`) are
   * token-owner ops, so the broadcaster must be the treasury (the
   * `DeployAppToken.s.sol` script enforces the same with
   * `NotTreasuryBroadcaster`). Use {@link treasuryGate} to enforce it.
   */
  treasury: string;
}

/**
 * Map a launch mint plan to {@link TokenDeployCallsParams}. All other deploy
 * knobs keep `DeployAppToken.s.sol`'s env defaults (salt 1, 0.1 ether paired
 * deposit, spread 100, buy/sell fee 200, zero default transfer validator) via
 * `buildTokenDeployCalls`' own defaults.
 */
export function deployParamsForPlan(
  inputs: MintPlanInputs,
  tokenAddress: string,
): TokenDeployCallsParams {
  const supply = inputs.supply.trim();
  if (!/^\d+$/.test(supply) || BigInt(supply) === 0n) {
    throw new Error(
      `token supply must be a positive whole number: ${inputs.supply}`,
    );
  }
  return {
    name: inputs.name,
    symbol: inputs.symbol,
    treasury: inputs.treasury,
    tokenAddress,
    // DeployAppToken.s.sol: `APPTOKEN_INITIAL_SUPPLY * 1e18`.
    initialSupplyAmount: BigInt(supply) * 10n ** 18n,
  };
}

// ---------------------------------------------------------------------------
// View calldata (the DeployAppToken.s.sol preconditions)
// ---------------------------------------------------------------------------

/** `infrastructureFeeBPS() -> uint16` on the TokenMaster router. */
export const SIGNATURE_INFRA_FEE_BPS = "infrastructureFeeBPS()";

/**
 * `computeDeploymentAddress(bytes32, PoolDeploymentParameters, uint256,
 * uint256) -> address` on the StandardPool factory. The tuple is
 * `PoolDeploymentParameters` in canonical ABI form (DataTypes.sol field
 * order).
 */
export const SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS =
  "computeDeploymentAddress(bytes32,(string,string,uint8,address,address," +
  "uint256,bytes,address,bool,address,uint256),uint256,uint256)";

/** Selector of {@link SIGNATURE_INFRA_FEE_BPS} (`cast sig`: `0xa82f4d02`). */
export const SELECTOR_INFRA_FEE_BPS = selectorOf(SIGNATURE_INFRA_FEE_BPS);
/** Selector of {@link SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS} (`cast`: `0x8d33f2bf`). */
export const SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS = selectorOf(
  SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS,
);

/**
 * `deployParams.maxInfrastructureFeeBPS` in `DeployAppToken.s.sol` (250) —
 * the cap `encodeDeployToken` bakes into the deploy call. A live router fee
 * above it makes `deployToken` revert (`InvalidInfrastructureFeeBPS`), so the
 * preflight blocks instead of sending a doomed transaction.
 */
export const MAX_INFRASTRUCTURE_FEE_BPS = 250n;

/** The `router.infrastructureFeeBPS()` view call (no arguments). */
export function buildInfraFeeView(
  router: string = DEFAULT_TOKENMASTER_ROUTER,
): EvmCall {
  return {
    to: router,
    data: encodeFunctionData(SIGNATURE_INFRA_FEE_BPS, [], []),
  };
}

/**
 * ABI layout of `encodeDeployToken`'s argument block, pinned against the
 * `cast`-generated goldens in `mintFlow.test.mjs`: the head is one offset word
 * (DeploymentParameters, dynamic) + three inline `SignatureECDSA` words; the
 * DeploymentParameters block is six static words + one `poolParams` offset
 * word, with the self-contained `PoolDeploymentParameters` tuple block as its
 * only tail. Because a tuple block's inner offsets are relative to its own
 * start, the extracted pool block can be spliced verbatim into another
 * argument block.
 */
const DEPLOY_ARGS_HEAD_WORDS = 4;
const DEPLOY_PARAMS_POOL_WORD = 5;
const DEPLOY_PARAMS_HEAD_WORDS = 7;

function bareArgs(calldata: string): string {
  const hex = calldata.toLowerCase().replace(/^0x/, "");
  if (hex.length <= 8 || (hex.length - 8) % 64 !== 0) {
    throw new Error("deploy calldata truncated");
  }
  return hex.slice(8);
}

function argWord(args: string, index: number): string {
  const word = args.slice(index * 64, index * 64 + 64);
  if (word.length !== 64) throw new Error("deploy calldata truncated");
  return word;
}

function wordValue(word: string): bigint {
  return BigInt(`0x${word}`);
}

function uint256Word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n)
    throw new Error(`uint256 out of range: ${value}`);
  return value.toString(16).padStart(64, "0");
}

/**
 * Cut the self-contained `PoolDeploymentParameters` tuple block out of a
 * `deployToken` calldata (from `encodeDeployToken`). Throws on layout drift or
 * truncation rather than encoding a wrong CREATE2 input.
 */
export function extractPoolParamsBlock(deployCalldata: string): string {
  const args = bareArgs(deployCalldata);
  const paramsOffset = wordValue(argWord(args, 0));
  const expectedHead = BigInt(DEPLOY_ARGS_HEAD_WORDS * 32);
  if (paramsOffset !== expectedHead) {
    throw new Error(
      `deploy calldata layout drift: DeploymentParameters at ${paramsOffset}, expected ${expectedHead}`,
    );
  }
  const paramsStart = Number(paramsOffset);
  const poolOffset = wordValue(
    argWord(args, paramsStart / 32 + DEPLOY_PARAMS_POOL_WORD),
  );
  const expectedPool = BigInt(DEPLOY_PARAMS_HEAD_WORDS * 32);
  if (poolOffset !== expectedPool) {
    throw new Error(
      `deploy calldata layout drift: poolParams at ${poolOffset}, expected ${expectedPool}`,
    );
  }
  const block = args.slice((paramsStart + Number(poolOffset)) * 2);
  if (block.length === 0 || block.length % 64 !== 0) {
    throw new Error("deploy calldata truncated");
  }
  return `0x${block}`;
}

/**
 * The `factory.computeDeploymentAddress(tokenSalt, poolParams, pairedValueIn,
 * infrastructureFeeBPS)` view call for the given deploy params and the LIVE
 * router fee (the script's exact precondition order).
 *
 * The salt, paired deposit, and `poolParams` are spliced out of
 * `encodeDeployToken(params)` so the CREATE2 input byte-matches what the
 * deploy transaction will actually send; `params.tokenAddress` never reaches
 * `PoolDeploymentParameters`, so a placeholder produces the identical call.
 */
export function buildComputeDeploymentAddressView(
  params: TokenDeployCallsParams,
  infrastructureFeeBps: bigint,
): EvmCall {
  const deployData = encodeDeployToken(params);
  const args = bareArgs(deployData);
  const paramsStart = Number(wordValue(argWord(args, 0)));
  // DeploymentParameters.tokenSalt (bytes32) — reused as the view's salt arg.
  const saltWord = argWord(args, paramsStart / 32 + 1);
  const poolBlock = extractPoolParamsBlock(deployData);
  // poolParams.initialPairedTokenToDeposit — the view's pairedValueIn arg
  // (DeployAppToken.s.sol passes the same `pairedDeposit` to both).
  const pairedWord = argWord(poolBlock.slice(2), 5);
  return {
    to: params.factory ?? DEFAULT_STANDARD_POOL_FACTORY,
    data:
      SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS +
      saltWord +
      uint256Word(BigInt(DEPLOY_ARGS_HEAD_WORDS * 32)) + // poolParams offset
      pairedWord +
      uint256Word(infrastructureFeeBps) +
      poolBlock.slice(2),
  };
}

/** Decode an eth_call 32-byte word as an address (left-padded, 20 bytes). */
export function decodeAddressWord(returnData: string): string {
  const word = returnData.replace(/^0x/, "").toLowerCase();
  if (word.length !== 64 || !/^[0-9a-f]*$/.test(word)) {
    throw new Error("expected a 32-byte return word");
  }
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) {
    throw new Error("expected a 32-byte address word");
  }
  return `0x${word.slice(24)}`;
}

// ---------------------------------------------------------------------------
// Preflight (prepare) — the two view calls, validated
// ---------------------------------------------------------------------------

/** Which preflight check produced a blocking failure. */
export type MintPreflightStage =
  | "plan"
  | "treasury"
  | "infrastructure-fee"
  | "token-address"
  | "token-state";

/** A preflight failure that names the exact check that failed. */
export class MintPrepareError extends Error {
  readonly stage: MintPreflightStage;

  constructor(stage: MintPreflightStage, message: string) {
    super(message);
    this.name = "MintPrepareError";
    this.stage = stage;
  }
}

/** Everything `buildTokenDeployCalls` needs, pre-derived. */
export interface PreparedDeploy {
  /** Deploy params with the computed CREATE2 `tokenAddress` filled in. */
  params: TokenDeployCallsParams;
  /** `buildTokenDeployCalls(params)` — the ordered 3-call sequence. */
  calls: EvmCall[];
  /** The precomputed CREATE2 token address (steps 2-3 target it). */
  tokenAddress: string;
  /** The live router fee used for the address computation. */
  infrastructureFeeBps: bigint;
}

/**
 * Run the `DeployAppToken.s.sol` VIEW preconditions: read the live
 * infrastructure fee, compute the CREATE2 token address, and re-derive the
 * ordered deploy calls (`buildTokenDeployCalls` — re-running this is what
 * makes a retry safe). Throws {@link MintPrepareError} naming the exact check.
 */
export async function prepareDeploy(
  effects: Pick<MintEffects, "call">,
  inputs: MintPlanInputs,
): Promise<PreparedDeploy> {
  let viewParams: TokenDeployCallsParams;
  try {
    viewParams = deployParamsForPlan(inputs, ZERO_ADDRESS);
  } catch (error) {
    throw new MintPrepareError("plan", mintErrorMessage(error));
  }

  let feeRaw: string;
  try {
    feeRaw = await effects.call(
      buildInfraFeeView(viewParams.router ?? DEFAULT_TOKENMASTER_ROUTER),
    );
  } catch (error) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `reading router.infrastructureFeeBPS() failed: ${mintErrorMessage(error)}`,
    );
  }
  let infrastructureFeeBps: bigint;
  try {
    infrastructureFeeBps = decodeUint256(feeRaw);
  } catch (error) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `router.infrastructureFeeBPS() returned a malformed word: ${mintErrorMessage(error)}`,
    );
  }
  if (infrastructureFeeBps > 65_535n) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `router.infrastructureFeeBPS() out of uint16 range: ${infrastructureFeeBps}`,
    );
  }
  if (infrastructureFeeBps > MAX_INFRASTRUCTURE_FEE_BPS) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `the router's infrastructure fee (${infrastructureFeeBps} bps) is above the ${MAX_INFRASTRUCTURE_FEE_BPS} bps deploy cap — the deploy would revert`,
    );
  }

  let addressRaw: string;
  try {
    addressRaw = await effects.call(
      buildComputeDeploymentAddressView(viewParams, infrastructureFeeBps),
    );
  } catch (error) {
    throw new MintPrepareError(
      "token-address",
      `factory.computeDeploymentAddress(...) failed: ${mintErrorMessage(error)}`,
    );
  }
  let tokenAddress: string;
  try {
    tokenAddress = decodeAddressWord(addressRaw);
  } catch (error) {
    throw new MintPrepareError(
      "token-address",
      `factory.computeDeploymentAddress(...) returned a malformed word: ${mintErrorMessage(error)}`,
    );
  }
  if (tokenAddress === ZERO_ADDRESS) {
    throw new MintPrepareError(
      "token-address",
      "factory.computeDeploymentAddress(...) returned the zero address",
    );
  }

  const params = { ...viewParams, tokenAddress };
  return {
    params,
    calls: buildTokenDeployCalls(params),
    tokenAddress,
    infrastructureFeeBps,
  };
}

// ---------------------------------------------------------------------------
// Treasury gate (v1: deployer == treasury)
// ---------------------------------------------------------------------------

/** Result of {@link treasuryGate}. */
export type TreasuryGate =
  | { ok: true; treasury: string }
  | { ok: false; detail: string };

/**
 * V1 allows deploying only when the wallet is the launch's treasury: calls
 * 2-3 are token-owner ops (`DeployAppToken.s.sol` reverts with
 * `NotTreasuryBroadcaster` otherwise), so a mismatch must block in the UI
 * instead of reverting onchain. An unset record treasury is adopted as the
 * wallet address.
 */
export function treasuryGate(
  deployer: string,
  recordTreasury: string | null | undefined,
): TreasuryGate {
  const wallet = deployer.trim();
  const recorded = (recordTreasury ?? "").trim();
  if (recorded === "") return { ok: true, treasury: wallet };
  if (recorded.toLowerCase() === wallet.toLowerCase()) {
    return { ok: true, treasury: wallet };
  }
  return {
    ok: false,
    detail: `The launch record's treasury (${recorded}) is not your wallet (${wallet}). In v1 the deploying wallet must be the treasury — steps 2-3 (transfer validator, trading ruleset) are token-owner operations. Update the launch's treasury to your wallet address (Edit terms), then deploy.`,
  };
}

// ---------------------------------------------------------------------------
// Flow state machine (pure reducer)
// ---------------------------------------------------------------------------

/** The three onchain steps, in `DeployAppToken.s.sol` broadcast order. */
export const MINT_STEPS = [
  {
    id: "deploy",
    label: "Deploy token",
    detail: "Creates the token and its pool (usually the slow step).",
  },
  {
    id: "validator",
    label: "Transfer validator",
    detail: "Wires the transfer validator on the new token.",
  },
  {
    id: "ruleset",
    label: "Trading ruleset",
    detail: "Opens trading with the Vanilla ruleset.",
  },
] as const;

export type MintStepId = (typeof MINT_STEPS)[number]["id"];

export type MintStepStatus = "pending" | "running" | "done" | "failed";

export interface MintStepState {
  status: MintStepStatus;
  /** Confirmed tx hash; null while pending/running or when reusing an
   *  earlier session's deploy (`tokenAlreadyDeployed`). */
  txHash: string | null;
}

export type MintPhase =
  | "idle"
  | "preparing"
  | "running"
  | "paused"
  | "linking"
  | "success"
  | "blocked";

export interface MintFailure {
  /** Which part of the flow failed: preflight, an onchain step, the record update. */
  stage: "prepare" | "step" | "link";
  /** `stage: "prepare"` — which check. */
  check: MintPreflightStage | null;
  /** `stage: "step"` — which of the three calls (0-based). */
  stepIndex: number | null;
  /** Mined tx hash (also present for a mined revert); null without a receipt. */
  txHash: string | null;
  /**
   * "reverted" — mined with status reverted (no state change from this tx);
   * "unknown" — no receipt (the tx may or may not have been broadcast).
   */
  outcome: "reverted" | "unknown" | null;
  reason: string;
}

export interface MintFlowState {
  phase: MintPhase;
  /** Exactly {@link MINT_STEPS}.length entries, index-aligned with it. */
  steps: MintStepState[];
  /** The precomputed CREATE2 token address (known before step 1 mines). */
  tokenAddress: string | null;
  /** Step 1 satisfied by code already at `tokenAddress` (earlier attempt). */
  tokenAlreadyDeployed: boolean;
  failure: MintFailure | null;
}

export type MintAction =
  | { type: "begin"; mode: "fresh" | "resume" }
  | { type: "blocked"; stage: MintPreflightStage; detail: string }
  | { type: "prepared"; tokenAddress: string; tokenAlreadyDeployed: boolean }
  | { type: "step_started"; index: number }
  | { type: "step_done"; index: number; txHash: string | null }
  | {
      type: "step_failed";
      index: number;
      txHash: string | null;
      outcome: "reverted" | "unknown";
      reason: string;
    }
  | { type: "link_started" }
  | { type: "link_failed"; reason: string }
  | { type: "linked" };

export type MintDispatch = (action: MintAction) => void;

export function initMintFlow(): MintFlowState {
  return {
    phase: "idle",
    steps: MINT_STEPS.map(() => ({ status: "pending", txHash: null })),
    tokenAddress: null,
    tokenAlreadyDeployed: false,
    failure: null,
  };
}

function withStep(
  state: MintFlowState,
  index: number,
  step: MintStepState,
): MintStepState[] {
  return state.steps.map((s, i) => (i === index ? step : s));
}

/** Pure flow reducer — the single state authority of the deploy card. */
export function mintFlowReducer(
  state: MintFlowState,
  action: MintAction,
): MintFlowState {
  switch (action.type) {
    case "begin": {
      const base =
        action.mode === "fresh"
          ? initMintFlow()
          : {
              ...state,
              // Keep completed steps; give the failed one a clean retry.
              steps: state.steps.map((s) =>
                s.status === "failed"
                  ? { status: "pending" as const, txHash: null }
                  : s,
              ),
            };
      return { ...base, phase: "preparing", failure: null };
    }
    case "blocked":
      return {
        ...state,
        phase: "blocked",
        failure: {
          stage: "prepare",
          check: action.stage,
          stepIndex: null,
          txHash: null,
          outcome: null,
          reason: action.detail,
        },
      };
    case "prepared": {
      const steps = state.steps.map((s) => ({ ...s }));
      if (action.tokenAlreadyDeployed && steps[0].status === "pending") {
        // A previous attempt already created the token — rerunning the deploy
        // call would revert on the CREATE2 address mismatch.
        steps[0] = { status: "done", txHash: null };
      }
      return {
        ...state,
        phase: "running",
        steps,
        tokenAddress: action.tokenAddress,
        tokenAlreadyDeployed: action.tokenAlreadyDeployed,
        failure: null,
      };
    }
    case "step_started":
      return {
        ...state,
        phase: "running",
        steps: withStep(state, action.index, {
          status: "running",
          txHash: null,
        }),
        failure: null,
      };
    case "step_done":
      return {
        ...state,
        steps: withStep(state, action.index, {
          status: "done",
          txHash: action.txHash,
        }),
      };
    case "step_failed":
      return {
        ...state,
        phase: "paused",
        steps: withStep(state, action.index, {
          status: "failed",
          txHash: action.txHash,
        }),
        failure: {
          stage: "step",
          check: null,
          stepIndex: action.index,
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
          stepIndex: null,
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

/** Index of the first not-done step (MINT_STEPS.length when all are done). */
export function resumeIndex(state: MintFlowState): number {
  const index = state.steps.findIndex((s) => s.status !== "done");
  return index === -1 ? state.steps.length : index;
}

/** What "retry" means in the current state (null = nothing to retry). */
export type MintRetryPlan =
  | { kind: "steps"; resumeAt: number }
  | { kind: "record"; tokenAddress: string }
  | null;

/**
 * Retry is always safe when offered:
 * - step failures resume at the failed step with re-derived calls; a retry of
 *   step 1 first verifies code at the token address (`tokenAlreadyDeployed`)
 *   because a no-receipt outcome is indistinguishable from "landed later";
 * - steps 2-3 are idempotent owner setters (same validator / ruleset again),
 *   so replaying them after an unknown outcome cannot corrupt state;
 * - a record-update failure keeps the deployed token and re-publishes only
 *   the record.
 * `null` while paused means retry is genuinely unavailable (say so in the UI).
 */
export function retryPlan(state: MintFlowState): MintRetryPlan {
  if (state.phase !== "paused") return null;
  if (state.failure?.stage === "link") {
    return state.tokenAddress
      ? { kind: "record", tokenAddress: state.tokenAddress }
      : null;
  }
  if (state.failure?.stage === "step") {
    return { kind: "steps", resumeAt: resumeIndex(state) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator: send the 3 calls sequentially
// ---------------------------------------------------------------------------

export interface MintRunOutcome {
  /** True when every step is done (the caller then links the record). */
  completed: boolean;
}

/**
 * Send `calls` one transaction at a time — each receipt is awaited before the
 * next broadcast, since the ordering is a hard protocol requirement. Halts on
 * the first failure and records exactly which step failed and why (mined
 * revert vs. unknown outcome); completed steps are never rolled back or
 * hidden.
 */
export async function runDeploySteps(input: {
  calls: EvmCall[];
  /** Resume point (0..2) — a retry resumes at the failed step. */
  startAt: number;
  effects: Pick<MintEffects, "send">;
  dispatch: MintDispatch;
}): Promise<MintRunOutcome> {
  const { calls, startAt, effects, dispatch } = input;
  if (calls.length !== MINT_STEPS.length) {
    throw new Error(
      `expected ${MINT_STEPS.length} deploy calls, got ${calls.length}`,
    );
  }
  for (let index = startAt; index < calls.length; index++) {
    dispatch({ type: "step_started", index });
    let receipt: MintTxReceipt;
    try {
      receipt = await effects.send(calls[index]);
    } catch (error) {
      dispatch({
        type: "step_failed",
        index,
        txHash: null,
        outcome: "unknown",
        reason: mintErrorMessage(error),
      });
      return { completed: false };
    }
    if (receipt.status !== "success") {
      dispatch({
        type: "step_failed",
        index,
        txHash: receipt.txHash,
        outcome: "reverted",
        reason: `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
      });
      return { completed: false };
    }
    dispatch({ type: "step_done", index, txHash: receipt.txHash });
  }
  return { completed: true };
}
