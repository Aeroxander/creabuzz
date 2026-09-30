/**
 * React wiring for the Manage panel's auction deploy + graduation execution:
 * the `evm_*` Tauri IPC contract (implemented in `desktop/src-tauri`) plus the
 * pure flows in `lib/auctionFlow.ts`.
 *
 * IPC contract (camelCase args; a rejected invoke is an error, never success):
 *   evm_wallet_status() -> { hasWallet, address }
 *   evm_chain_status({ rpcUrl }) -> { chainId }
 *   evm_call({ rpcUrl, to, data }) -> { returnData }
 *   evm_send_transaction({ rpcUrl, chainId, to?, data, value?, gasLimit? })
 *     -> { txHash, status, blockNumber, gasUsed, contractAddress }
 * `to` omitted = contract creation (deploy); `contractAddress` then carries
 * the created address. A mined `status: "reverted"` is DATA (a failed step),
 * not an exception. Two reads the IPC surface lacks ride the chainRpc
 * direct-JSON-RPC pattern (`eth_getTransactionCount` for CREATE-address
 * prediction, `eth_blockNumber` for graduation readiness).
 *
 * Every chain effect goes through `lib/auctionFlow.ts`'s injectable ports
 * (unit-tested with fakes); this module only binds the Tauri IPC commands and
 * the record/mirror publish mutations. The GraduationExecutor address is
 * deliberately recovered from chain at readiness time (`fundsRecipient()`) —
 * the record template has no field for it — so graduation works even after a
 * reload that loses the deploy flow's session state.
 */

import * as React from "react";

import {
  isContractDeployed,
  hexToBigInt,
} from "@/features/launchpad/lib/chainRpc";
import { buildGraduationCall } from "@/features/launchpad/lib/evmCalls";
import {
  auctionDeployReducer,
  auctionErrorMessage,
  initAuctionDeployState,
  retryPlan,
  runAuctionDeploy,
  type AuctionDispatch,
  type AuctionEffects,
  type AuctionPlanInputs,
  type AuctionSendCall,
  type AuctionTxReceipt,
} from "@/features/launchpad/lib/auctionFlow";
import {
  buildGraduationsView,
  checkGraduationReadiness,
  decodeGraduationRecord,
  GRADUATION_STEPS,
  graduationFlowReducer,
  graduationRetryPlan,
  initialGraduationState,
  runGraduationFlow,
  type GraduationDeps,
  type GraduationFlowState,
  type GraduationReadiness,
  type GraduationRetryPlan,
  type GraduationStepId,
} from "@/features/launchpad/lib/graduationFlow";
import { invokeTauri } from "@/shared/api/tauri";

/** `evm_call()` result (the shared IPC shape in `walletHooks.ts`). */
interface EvmCallResult {
  returnData: string;
}

const RPC_TIMEOUT_MS = 6000;

/** Minimal JSON-RPC quantity read (chainRpc's direct-fetch pattern). */
async function rpcQuantity(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<bigint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "rpc error");
    if (typeof body.result !== "string") throw new Error("bad rpc result");
    return hexToBigInt(body.result);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `AuctionEffects` port set, bound to the IPC commands and the configured
 * RPC endpoint. `to` is OMITTED (not null, not empty) on contract-creation
 * sends — the IPC contract keys creation on its absence.
 */
export function makeAuctionEffects(input: {
  rpcUrl: string;
  chainId: number;
  deployer: string;
}): AuctionEffects {
  const { rpcUrl, chainId, deployer } = input;
  return {
    call: async ({ to, data }) => {
      const result = await invokeTauri<EvmCallResult>("evm_call", {
        rpcUrl,
        to,
        data,
      });
      return result.returnData;
    },
    send: (call: AuctionSendCall) => {
      const args: {
        rpcUrl: string;
        chainId: number;
        data: string;
        value?: string;
        to?: string;
      } = {
        rpcUrl,
        chainId,
        data: call.data,
        value: call.value ?? "0x0",
      };
      if (call.to !== undefined) args.to = call.to;
      return invokeTauri<AuctionTxReceipt>("evm_send_transaction", args);
    },
    codeAt: (address) => isContractDeployed(rpcUrl, address),
    transactionCount: () =>
      rpcQuantity(rpcUrl, "eth_getTransactionCount", [deployer, "latest"]),
    blockNumber: () => rpcQuantity(rpcUrl, "eth_blockNumber", []),
  };
}

// ---------------------------------------------------------------------------
// Deploy auction
// ---------------------------------------------------------------------------

export interface AuctionDeployFlowInput {
  /** The launch record's sale fields (lib/launchRecord.ts shapes). */
  plan: AuctionPlanInputs;
  /** The signing wallet (the CREATE-address prediction input). */
  deployer: string;
  rpcUrl: string;
  /** Chain id reported by `evm_chain_status` — sent with every transaction. */
  chainId: number;
  /** Republish the kind-37001 record with the deployed `auction` tag. */
  onLink: (input: { auction: string }) => Promise<unknown>;
  /** CCA factory override (default: the canonical v2.1.0 factory). */
  factory?: string;
  /** GraduationExecutor reserve share (default 4000 = 40%). */
  reserveBps?: number;
}

export interface AuctionDeployFlow {
  state: ReturnType<typeof auctionDeployReducer>;
  /** True while preparing, sending transactions, or updating the record. */
  busy: boolean;
  /** Fresh deploy: preflight → CREATE/CREATE2 sequence → record update. */
  start: () => void;
  /** Resume from the failed step, or retry just the record update. */
  retry: () => void;
}

/** Drive the auction deploy's state machine (mintHooks' `useTokenDeployFlow` shape). */
export function useAuctionDeployFlow(
  input: AuctionDeployFlowInput,
): AuctionDeployFlow {
  const { plan, deployer, rpcUrl, chainId, onLink, factory, reserveBps } =
    input;
  const [state, dispatch] = React.useReducer(
    auctionDeployReducer,
    plan.admission,
    initAuctionDeployState,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const run = React.useCallback(
    (mode: "fresh" | "resume"): void => {
      void runAuctionDeploy({
        effects: makeAuctionEffects({ rpcUrl, chainId, deployer }),
        plan,
        deployer,
        ...(factory !== undefined ? { factory } : {}),
        ...(reserveBps !== undefined ? { reserveBps } : {}),
        dispatch: dispatch as AuctionDispatch,
        mode,
        previous: stateRef.current,
        onLink,
      });
    },
    [chainId, deployer, factory, onLink, plan, reserveBps, rpcUrl],
  );

  const start = React.useCallback(() => run("fresh"), [run]);
  const retry = React.useCallback(() => {
    const planToRetry = retryPlan(stateRef.current);
    if (!planToRetry) return;
    if (planToRetry.kind === "record") {
      dispatch({ type: "link_started" });
      void onLink({ auction: planToRetry.auctionAddress })
        .then(() => dispatch({ type: "linked" }))
        .catch((error: unknown) =>
          dispatch({ type: "link_failed", reason: auctionErrorMessage(error) }),
        );
      return;
    }
    run("resume");
  }, [onLink, run]);

  const busy =
    state.phase === "preparing" ||
    state.phase === "running" ||
    state.phase === "linking";
  return { state, busy, start, retry };
}

// ---------------------------------------------------------------------------
// Execute graduation
// ---------------------------------------------------------------------------

export type GraduationPublishReceipt = (
  kind: "sweep" | "lock",
  parts: { extraTags: string[][]; content: Record<string, string> },
) => Promise<unknown>;

export interface GraduationFlowInput {
  /** The `auction` tag — the deployed CCA auction. */
  auction: string;
  /**
   * The GraduationExecutor. Null = recover it from chain at check time
   * (`fundsRecipient()`, verified equal to `tokensRecipient()`).
   */
  executor: string | null;
  /** The record's `endBlock` (readiness "is the auction over?" comparison). */
  endBlock: number | null;
  rpcUrl: string;
  chainId: number;
  /** Publish one 47005 receipt (`usePublishLaunchMirrorMutation`). */
  publishReceipt: GraduationPublishReceipt;
}

export interface GraduationFlow {
  state: GraduationFlowState;
  /** True while checking readiness, executing, or publishing receipts. */
  busy: boolean;
  /** Run (or re-run) the readiness reads. */
  check: () => void;
  /** Execute the graduation, then publish the bound receipts. */
  start: () => void;
  /** Retry semantics: re-check / re-execute remaining / mirror-only. */
  retry: () => void;
  retryPlan: GraduationRetryPlan;
}

/**
 * Drive the graduation state machine. `check()` runs the contract's own
 * gates via view calls; `start()` sends `executeGraduation` and publishes the
 * 47005 `sweep`/`lock` receipts bound to the confirmed tx hash.
 */
export function useGraduationFlow(input: GraduationFlowInput): GraduationFlow {
  const { auction, executor, endBlock, rpcUrl, chainId, publishReceipt } =
    input;
  const [state, dispatch] = React.useReducer(
    graduationFlowReducer,
    undefined,
    initialGraduationState,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const effects = React.useMemo(
    () => makeAuctionEffects({ rpcUrl, chainId, deployer: "" }),
    [chainId, rpcUrl],
  );

  const check = React.useCallback(() => {
    dispatch({ type: "check_start" });
    void checkGraduationReadiness({ effects, auction, endBlock })
      .then((readiness: GraduationReadiness) =>
        dispatch({ type: "check_result", readiness }),
      )
      .catch((error: unknown) =>
        dispatch({
          type: "check_failed",
          message: auctionErrorMessage(error),
        }),
      );
  }, [auction, effects, endBlock]);

  const start = React.useCallback(() => {
    const executorAddress = stateRef.current.readiness?.executor ?? executor;
    if (!executorAddress) {
      dispatch({
        type: "check_failed",
        message:
          "the GraduationExecutor address is unknown — run the readiness check first",
      });
      return;
    }
    const order: GraduationStepId[] = GRADUATION_STEPS.map((s) => s.id);
    dispatch({ type: "reset", order });
    const deps: GraduationDeps = {
      send: (call) => effects.send(call),
      readGraduation: async () => {
        const raw = await effects.call(
          buildGraduationsView(executorAddress, auction),
        );
        return decodeGraduationRecord(raw);
      },
      publishReceipt,
    };
    void runGraduationFlow(
      {
        auction,
        executor: executorAddress,
        call: buildGraduationCall(executorAddress, auction),
      },
      deps,
      dispatch,
    );
  }, [auction, effects, executor, publishReceipt]);

  const retry = React.useCallback(() => {
    const plan = graduationRetryPlan(stateRef.current);
    if (!plan) return;
    if (plan.kind === "check") {
      check();
      return;
    }
    const current = stateRef.current;
    const executorAddress = current.readiness?.executor ?? executor;
    if (!executorAddress) {
      check();
      return;
    }
    const completed = new Set<GraduationStepId>(
      GRADUATION_STEPS.map((s) => s.id).filter(
        (id) => current.steps[id] === "done",
      ),
    );
    const deps: GraduationDeps = {
      send: (call) => effects.send(call),
      readGraduation: async () => {
        const raw = await effects.call(
          buildGraduationsView(executorAddress, auction),
        );
        return decodeGraduationRecord(raw);
      },
      publishReceipt,
    };
    void runGraduationFlow(
      {
        auction,
        executor: executorAddress,
        call: buildGraduationCall(executorAddress, auction),
      },
      deps,
      dispatch,
      { completed, graduationTxHash: current.graduationTxHash },
    );
  }, [auction, check, effects, executor, publishReceipt]);

  const busy = state.phase === "checking" || state.phase === "running";
  return {
    state,
    busy,
    check,
    start,
    retry,
    retryPlan: graduationRetryPlan(state),
  };
}
