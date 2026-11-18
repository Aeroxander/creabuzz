/**
 * React wiring for the Manage panel's one-click token deploy: the `evm_*`
 * Tauri IPC contract (implemented in `desktop/src-tauri`) plus the pure flow in
 * `lib/mintFlow.ts`.
 *
 * IPC contract (camelCase args; a rejected invoke is an error, never success):
 *   evm_wallet_status() -> { hasWallet, address }
 *   evm_chain_status({ rpcUrl }) -> { chainId }
 *   evm_call({ rpcUrl, to, data }) -> { returnData }
 *   evm_send_transaction({ rpcUrl, chainId, to, data, value?, gasLimit? })
 *     -> { txHash, status, blockNumber, gasUsed, contractAddress }
 * A mined `status: "reverted"` is DATA (a failed step), not an exception.
 *
 * The deployer wallet doubles as the token treasury in v1 (see
 * `treasuryGate`): calls 2-3 of `buildTokenDeployCalls` are token-owner ops,
 * so the broadcaster must be the treasury or they revert onchain. The flow
 * blocks on a recorded-treasury mismatch instead of reverting.
 *
 * The wallet- and chain-status queries have ONE home: `walletHooks.ts`
 * (`useWalletStatusQuery` / `useChainStatusQuery`). This module keeps only the
 * Manage panel's explicit-gating chain-status variant (below), which shares
 * `chainStatusQueryKey` so both variants read one cache entry.
 */

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { isContractDeployed } from "@/features/launchpad/lib/chainRpc";
import {
  initMintFlow,
  mintFlowReducer,
  mintErrorMessage,
  MintPrepareError,
  prepareDeploy,
  resumeIndex,
  retryPlan,
  runDeploySteps,
  treasuryGate,
  type MintDispatch,
  type MintEffects,
  type MintFlowState,
  type MintPlanInputs,
  type MintPreflightStage,
  type MintTxReceipt,
  type PreparedDeploy,
} from "@/features/launchpad/lib/mintFlow";
import {
  chainStatusQueryKey,
  type EvmChainStatus,
} from "@/features/launchpad/walletHooks";
import { invokeTauri } from "@/shared/api/tauri";

interface EvmCallResult {
  returnData: string;
}

const EVM_STALE_TIME_MS = 30_000;

/**
 * Is the configured RPC endpoint reachable, and which chain is it on?
 *
 * The Manage panel's variant of `walletHooks.useChainStatusQuery`: explicit
 * caller gating (only probe once a wallet exists) and `retry: false` (an
 * unreachable endpoint is shown immediately, not after retries). It shares
 * `chainStatusQueryKey` with the wallet-card variant so the same fact has one
 * cache entry — the two wrappers differ only in gating/refetch policy.
 */
export function useEvmChainStatusQuery(rpcUrl: string, enabled: boolean) {
  const endpoint = rpcUrl.trim();
  return useQuery({
    queryKey: chainStatusQueryKey(endpoint),
    queryFn: () =>
      invokeTauri<EvmChainStatus>("evm_chain_status", { rpcUrl: endpoint }),
    enabled,
    retry: false,
    staleTime: EVM_STALE_TIME_MS,
  });
}

export interface TokenDeployFlowInput {
  /** The launch's mint plan — the deploy's token parameters. */
  plan: Omit<MintPlanInputs, "treasury">;
  /** The signing wallet; also the token treasury in v1. */
  deployer: string;
  /** The launch record's `treasury` tag (must match `deployer` when set). */
  recordTreasury: string | null;
  rpcUrl: string;
  /** Chain id reported by `evm_chain_status` — sent with every transaction. */
  chainId: number;
  /** Republish the kind-37001 record with the deployed `token` tag. */
  onLink: (input: { token: string; treasury: string }) => Promise<unknown>;
}

export interface TokenDeployFlow {
  state: MintFlowState;
  /** True while preparing, sending transactions, or updating the record. */
  busy: boolean;
  /** Fresh deploy: preflight -> 3 sequential calls -> record update. */
  start: () => void;
  /** Resume from the failed step, or retry just the record update. */
  retry: () => void;
}

/**
 * Drive the deploy flow's state machine. Every chain effect goes through
 * `lib/mintFlow.ts`'s injectable ports (unit-tested with fakes); this hook
 * only binds the Tauri IPC commands and the record-update mutation.
 */
export function useTokenDeployFlow(
  input: TokenDeployFlowInput,
): TokenDeployFlow {
  const { plan, deployer, recordTreasury, rpcUrl, chainId, onLink } = input;
  const [state, dispatch] = React.useReducer(
    mintFlowReducer,
    undefined,
    initMintFlow,
  );

  const linkRecord = React.useCallback(
    async (tokenAddress: string, dispatchTo: MintDispatch) => {
      dispatchTo({ type: "link_started" });
      try {
        await onLink({ token: tokenAddress, treasury: deployer });
        dispatchTo({ type: "linked" });
      } catch (error) {
        dispatchTo({ type: "link_failed", reason: mintErrorMessage(error) });
      }
    },
    [deployer, onLink],
  );

  const run = React.useCallback(
    async (mode: "fresh" | "resume"): Promise<void> => {
      const gate = treasuryGate(deployer, recordTreasury);
      if (!gate.ok) {
        dispatch({ type: "blocked", stage: "treasury", detail: gate.detail });
        return;
      }
      const resumeAt = mode === "resume" ? resumeIndex(state) : 0;
      dispatch({ type: "begin", mode });

      // `value` is the hex quantity `EvmCall.value` carries ("0x0" when the
      // call moves no native value); gas is left to the node's estimator.
      const effects: MintEffects = {
        call: async (target) => {
          const result = await invokeTauri<EvmCallResult>("evm_call", {
            rpcUrl,
            to: target.to,
            data: target.data,
          });
          return result.returnData;
        },
        send: (call) =>
          invokeTauri<MintTxReceipt>("evm_send_transaction", {
            rpcUrl,
            chainId,
            to: call.to,
            data: call.data,
            value: call.value ?? "0x0",
          }),
      };

      let prepared: PreparedDeploy;
      try {
        prepared = await prepareDeploy(effects, {
          ...plan,
          treasury: gate.treasury,
        });
      } catch (error) {
        const stage: MintPreflightStage =
          error instanceof MintPrepareError ? error.stage : "plan";
        dispatch({
          type: "blocked",
          stage,
          detail: mintErrorMessage(error),
        });
        return;
      }

      // A previous attempt may already have created the token (its outcome is
      // kept onchain, not in app state) — rerunning the deploy call would
      // revert on the CREATE2 address mismatch. Surface the check's own
      // failures rather than guessing (rule: no silent fallbacks).
      let tokenAlreadyDeployed: boolean;
      try {
        tokenAlreadyDeployed = await isContractDeployed(
          rpcUrl,
          prepared.tokenAddress,
        );
      } catch (error) {
        dispatch({
          type: "blocked",
          stage: "token-state",
          detail: `verifying ${prepared.tokenAddress} onchain failed: ${mintErrorMessage(error)}`,
        });
        return;
      }
      dispatch({
        type: "prepared",
        tokenAddress: prepared.tokenAddress,
        tokenAlreadyDeployed,
      });

      const outcome = await runDeploySteps({
        calls: prepared.calls,
        startAt: Math.max(resumeAt, tokenAlreadyDeployed ? 1 : 0),
        effects,
        dispatch,
      });
      if (!outcome.completed) return;
      await linkRecord(prepared.tokenAddress, dispatch);
    },
    [deployer, linkRecord, plan, recordTreasury, rpcUrl, chainId, state],
  );

  const start = React.useCallback(() => {
    void run("fresh");
  }, [run]);

  const retry = React.useCallback(() => {
    const planToRetry = retryPlan(state);
    if (!planToRetry) return;
    if (planToRetry.kind === "record") {
      void linkRecord(planToRetry.tokenAddress, dispatch);
      return;
    }
    void run("resume");
  }, [linkRecord, run, state]);

  const busy =
    state.phase === "preparing" ||
    state.phase === "running" ||
    state.phase === "linking";

  return { state, busy, start, retry };
}
