/**
 * React wiring for launching a project into its own DAO from the Manage panel: the pure run
 * (`@creaton/core` `daoLaunchFlow.ts`) bound to the injected wallet, the launch record and the receipt mirror.
 *
 * The hash of the mined transaction is stored the moment it lands (`graduationTxStore`, keyed by launch), so a reload
 * between "the DAO exists" and "the launch page knows" offers to finish saving rather than a second launch.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import {
  daoLaunchKit,
  ethCall,
  ethGetLogs,
  ethTransactionReceipt,
  getRpcEndpoint,
  isMainnetChain,
  mainnetEnabled,
} from "./chain";
import {
  daoLaunchGate,
  daoLaunchInputsFromRecord,
  daoLaunchReceiptContent,
  DaoLaunchPlanError,
  type DaoLaunchPanelInput,
  describeDaoLaunch,
  planDaoLaunch,
  TOPIC_KIT_LAUNCHED,
  type DaoLaunchGate,
  type DaoLaunchPlan,
} from "./lib/dao-launch";
import {
  EMPTY_DAO_LAUNCH_PROGRESS,
  runDaoLaunch,
  type DaoLaunchProgress,
  type DaoLaunchRetry,
  type DaoLaunchStep,
} from "./lib/dao-launch-flow";
import { graduationTxStore } from "./lib/graduation-progress";
import { makeWalletAuctionEffects } from "./lib/wallet-effects";
import type { Launch } from "./models";
import type { ConnectedWalletState } from "./use-connected-wallet";
import { usePublishMirror } from "./use-launches";

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
/** `GraduationExecutor.treasury()`. */
const SELECTOR_TREASURY = "0x61d027b3";

function chainNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface DaoLaunchView {
  plan: DaoLaunchPlan | null;
  /** Why the terms cannot launch, in words the founder can act on. */
  planProblem: string | null;
  gate: DaoLaunchGate;
  summary: ReturnType<typeof describeDaoLaunch> | null;
  kit: string | null;
}

export interface DaoLaunchState {
  progress: DaoLaunchProgress;
  running: boolean;
  /** A launch transaction is stored from an earlier visit and its bookkeeping is unfinished. */
  resumable: boolean;
  failure: {
    step: DaoLaunchStep;
    message: string;
    retry: DaoLaunchRetry;
  } | null;
  done: boolean;
}

/** The Manage panel's DAO launch: the terms and gate, the run, and its resume. */
export function useDaoLaunch(input: {
  launch: Launch;
  wallet: ConnectedWalletState;
  /** Saves the DAO's Shares, auction and treasury on the launch record; must PROPAGATE errors. */
  onLink: (link: {
    token: string;
    auction: string;
    treasury: string;
  }) => Promise<unknown>;
  /** Who judges the team's milestones, as the founder named them (null until they have). */
  panel?: DaoLaunchPanelInput | null;
}): { view: DaoLaunchView; state: DaoLaunchState; start: () => void } {
  const { launch, wallet, onLink, panel = null } = input;
  const { record } = launch;
  const chainId = chainNumber(record.chainId);
  const kit = daoLaunchKit(record.chainId);
  const publishMirror = usePublishMirror().mutateAsync;
  const launchKey = `dao-launch:${record.author}:${record.id}`;
  const txStore = useMemo(() => graduationTxStore(launchKey), [launchKey]);

  const { plan, planProblem } = useMemo(() => {
    try {
      // The team seat is the connected wallet; a zero address stands in until one is connected, so the terms can be
      // judged before the founder has connected anything (the gate asks for the wallet before it lets them send).
      const founder = wallet.address ?? ZERO_ADDRESS;
      const planned = planDaoLaunch(
        daoLaunchInputsFromRecord(record, founder, { panel }),
      );
      if (record.admission === "curated") {
        return {
          plan: null,
          planProblem:
            "A project with its own DAO opens its sale to everyone. Switch this launch to the open sale, or sell a separate token.",
        };
      }
      return { plan: planned, planProblem: null };
    } catch (error) {
      if (error instanceof DaoLaunchPlanError) {
        return { plan: null, planProblem: error.message };
      }
      throw error;
    }
  }, [record, wallet.address, panel]);

  const gate = daoLaunchGate({
    mainnetBlocked: isMainnetChain(record.chainId) && !mainnetEnabled(),
    kit,
    planProblem,
    address: wallet.address,
    walletChainId: wallet.chainId,
    launchChainId: chainId,
  });

  const [progress, setProgress] = useState<DaoLaunchProgress>(
    EMPTY_DAO_LAUNCH_PROGRESS,
  );
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<DaoLaunchState["failure"]>(null);
  const [done, setDone] = useState(false);
  const [resumable, setResumable] = useState(() => txStore.load() !== null);
  // A run in flight cannot be started twice by a second click.
  const inFlight = useRef(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  const start = useCallback(() => {
    if (inFlight.current || !plan || !kit || chainId === null) return;
    const resuming = txStore.load() !== null || progressRef.current.txHash;
    // A fresh send needs a connected wallet on the right chain; finishing the bookkeeping of one that already mined
    // needs neither (it only reads the network and talks to the server).
    if (!resuming && (!wallet.wallet || !gate.ok)) return;
    inFlight.current = true;
    setRunning(true);
    setFailure(null);
    const walletEffects = wallet.wallet
      ? makeWalletAuctionEffects({
          provider: wallet.wallet.provider,
          deployer: wallet.wallet.address,
          chainId,
        })
      : null;
    const needWallet = (): never => {
      throw new Error("Connect your wallet to launch.");
    };
    void runDaoLaunch(
      {
        effects: {
          call: walletEffects?.call ?? needWallet,
          send: walletEffects?.send ?? needWallet,
          codeAt: walletEffects?.codeAt ?? needWallet,
        },
        kit,
        plan,
        launcher: wallet.address,
        txStore,
        findLaunch: async (executor) => {
          // The executor was retargeted to the DAO by the kit, so its treasury is the DAO; the kit's own event for
          // that DAO carries the rest.
          const endpoint = getRpcEndpoint();
          const treasury = await ethCall(endpoint, executor, SELECTOR_TREASURY);
          const dao = `0x${treasury.replace(/^0x/, "").slice(-40)}`;
          const logs = await ethGetLogs(endpoint, {
            address: kit,
            topics: [TOPIC_KIT_LAUNCHED, `0x${dao.slice(2).padStart(64, "0")}`],
            fromBlock: "0x0",
            toBlock: "latest",
          });
          const first = logs[0];
          return first ? { txHash: first.transactionHash, logs } : null;
        },
        readReceipt: async (hash) => {
          const found = await ethTransactionReceipt(getRpcEndpoint(), hash);
          if (!found) return null;
          return {
            status: found.status === "0x1" ? "success" : "reverted",
            logs: found.logs ?? [],
          };
        },
        link: (launched) =>
          onLink({
            token: launched.shares,
            auction: launched.auction,
            treasury: launched.dao,
          }),
        publish: (launched, txHash) =>
          publishMirror({
            kind: KIND_LAUNCH_RECEIPT,
            author: record.author,
            launchId: record.id,
            extraTags: [
              ["kind", "dao-launch"],
              ["tx", txHash],
              ["chain", record.chainId ?? ""],
              ["contract", kit],
            ],
            content: daoLaunchReceiptContent({
              launched,
              plan,
              chainId: record.chainId ?? "",
              kit,
            }),
          }),
        onProgress: (next) => {
          progressRef.current = next;
          setProgress(next);
        },
      },
      progressRef.current,
    )
      .then((outcome) => {
        setProgress(outcome.progress);
        if (outcome.ok) {
          setDone(true);
          setResumable(false);
        } else {
          setFailure({
            step: outcome.step,
            message: outcome.message,
            retry: outcome.retry,
          });
          setResumable(txStore.load() !== null);
        }
      })
      .finally(() => {
        inFlight.current = false;
        setRunning(false);
      });
  }, [
    chainId,
    gate.ok,
    kit,
    onLink,
    plan,
    publishMirror,
    record.author,
    record.chainId,
    record.id,
    txStore,
    wallet.address,
    wallet.wallet,
  ]);

  return {
    view: {
      plan,
      planProblem,
      gate,
      summary: plan ? describeDaoLaunch(plan) : null,
      kit,
    },
    state: { progress, running, resumable, failure, done },
    start,
  };
}
