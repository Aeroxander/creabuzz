/**
 * React wiring for starting a contributor project: which network, which contributor kit and currency it has, whether
 * the founder can send, and the run itself (`lib/contributor-flow.ts`) bound to the injected wallet, the chain and the
 * server. The job is kept in this browser per founder, so a reload offers to finish it instead of starting over.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  contributorKit,
  daoLaunchKit,
  ethCall,
  ethChainId,
  getRpcEndpoint,
  isContractDeployed,
  isMainnetChain,
  localUsdcAddress,
  mainnetEnabled,
  ethPendingNonce,
  networkLabel,
} from "@/features/launchpad/chain";
import { ideaId } from "@/features/launchpad/lib/idea";
import { usdcAddress } from "@/features/launchpad/lib/sale-currency";
import { makeWalletAuctionEffects } from "@/features/launchpad/lib/wallet-effects";
import { useConnectedWallet } from "@/features/launchpad/use-connected-wallet";
import {
  useCreateLaunch,
  useLaunches,
} from "@/features/launchpad/use-launches";
import { endpointChain } from "@/features/launchpad/use-work";
import { existingUserPubkey } from "@/shared/lib/identity";

import {
  type ContributorFlowState,
  type ContributorJob,
  type ContributorStep,
  contributorFlow,
  JOB_STORAGE_PREFIX,
  parseJob,
  runContributorStart,
  stateForJob,
} from "./lib/contributor-flow";
import {
  CALL_DECIMALS,
  CALL_SUMMONER,
  type ContributorDraft,
  contributorSalt,
  contributorTerms,
  wordAddress,
} from "./lib/contributor-project";

/** What stands between the founder and pressing Start, in words they can act on; null when nothing does. */
export type ContributorGate =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "reading"
        | "no-network"
        | "mainnet"
        | "unavailable"
        | "no-currency"
        | "sign-in"
        | "wallet"
        | "wrong-chain";
      message: string;
    };

function loadJob(key: string | null): ContributorJob | null {
  if (!key) return null;
  try {
    return parseJob(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function storeJob(key: string, job: ContributorJob | null) {
  try {
    if (job) localStorage.setItem(key, JSON.stringify(job));
    else localStorage.removeItem(key);
  } catch {
    // Private windows can refuse storage: the run still works, it just cannot be picked up after a reload.
  }
}

export function useContributorStart() {
  const me = existingUserPubkey();
  const wallet = useConnectedWallet();
  const launches = useLaunches();
  const create = useCreateLaunch().mutateAsync;
  const endpoint = getRpcEndpoint();

  // The network is the one the app reads; the wallet has to be on it too.
  const network = useQuery({
    queryKey: ["start", "contributor", "network", endpoint],
    queryFn: async () => {
      const chainId = Number(await ethChainId(endpoint));
      const kit = contributorKit(chainId);
      const launchKit = daoLaunchKit(chainId);
      const currency = usdcAddress(chainId, localUsdcAddress());
      const [expectedSummoner, decimals] = await Promise.all([
        launchKit
          ? ethCall(endpoint, launchKit, CALL_SUMMONER).then(wordAddress)
          : null,
        currency
          ? ethCall(endpoint, currency, CALL_DECIMALS).then((hex) =>
              Number(BigInt(hex.slice(0, 66))),
            )
          : null,
      ]);
      return { chainId, kit, expectedSummoner, currency, decimals };
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const storageKey = me ? `${JOB_STORAGE_PREFIX}${me}` : null;
  const [job, setJob] = useState<ContributorJob | null>(() =>
    loadJob(storageKey),
  );
  const [flow, setFlow] = useState<ContributorFlowState>(() =>
    job ? stateForJob(job) : contributorFlow.initial(),
  );
  const inFlight = useRef(false);

  const gate = useMemo<ContributorGate>(() => {
    if (network.isPending)
      return {
        ok: false,
        reason: "reading",
        message: "Reading the network…",
      };
    if (network.isError || !network.data)
      return {
        ok: false,
        reason: "no-network",
        message:
          "The network could not be reached. Check the network setting and try again.",
      };
    const { chainId, kit, currency, decimals } = network.data;
    if (isMainnetChain(chainId) && !mainnetEnabled())
      return {
        ok: false,
        reason: "mainnet",
        message:
          "Contributor projects are only offered on test networks for now.",
      };
    if (!kit)
      return {
        ok: false,
        reason: "unavailable",
        message: `Contributor projects cannot be started on ${networkLabel(chainId)} yet: this app does not know a contract there that makes one.`,
      };
    if (!currency || decimals === null)
      return {
        ok: false,
        reason: "no-currency",
        message: `This app does not know a currency on ${networkLabel(chainId)} for contributors' optional deposits, so it cannot open a work budget there.`,
      };
    if (!me)
      return {
        ok: false,
        reason: "sign-in",
        message: "Sign in first: the project is published under your name.",
      };
    if (!wallet.address)
      return {
        ok: false,
        reason: "wallet",
        message:
          "Connect a wallet. It holds your starting Shares and sends the one transaction that makes the project.",
      };
    if (wallet.chainId !== chainId)
      return {
        ok: false,
        reason: "wrong-chain",
        message: `Your wallet is on another network. Switch it to ${networkLabel(chainId)}.`,
      };
    return { ok: true };
  }, [network.isPending, network.isError, network.data, me, wallet]);

  const run = useCallback(
    (start: ContributorJob) => {
      if (inFlight.current || !storageKey || !wallet.wallet) return;
      inFlight.current = true;
      // Kept before anything is sent: a reload during the first wallet prompt then offers to finish this project.
      storeJob(storageKey, start);
      setJob(start);
      let state = stateForJob(start);
      setFlow(state);
      const wallets = makeWalletAuctionEffects({
        provider: wallet.wallet.provider,
        deployer: wallet.wallet.address,
        chainId: start.chainId,
      });
      const chain = endpointChain(endpoint);
      void runContributorStart(
        start,
        {
          call: (to, data) => ethCall(endpoint, to, data),
          codeAt: (address) => isContractDeployed(endpoint, address),
          // The pending count: a budget another project is making in a block not yet mined is counted too.
          nonceOf: (address) => ethPendingNonce(endpoint, address),
          send: async (to, data) => {
            const receipt = await wallets.send({ to, data, value: "0x0" });
            return {
              txHash: receipt.txHash,
              status: receipt.status === "success" ? "success" : "reverted",
            };
          },
          now: () => chain.now(),
          publish: async (input) => {
            await create(input);
          },
          save: (next) => {
            storeJob(storageKey, next);
            setJob(next);
          },
        },
        (action) => {
          state = contributorFlow.reducer(state, action);
          setFlow(state);
        },
      ).finally(() => {
        inFlight.current = false;
      });
    },
    [create, endpoint, storageKey, wallet.wallet],
  );

  /**
   * Start a new project from the form. Throws a `ContributorInputError` for a draft that cannot start. `fromBoard` is a
   * Projects-board project's id: the launch then takes that id, so the board links to it (D84).
   */
  const start = useCallback(
    (draft: ContributorDraft, fromBoard?: string) => {
      if (!gate.ok || !network.data || !me || !wallet.address) return;
      const { chainId, kit, expectedSummoner, currency } = network.data;
      const terms = contributorTerms(draft, wallet.address);
      const taken = (launches.data ?? [])
        .filter((launch) => launch.record.author === me)
        .map((launch) => launch.record.id);
      const launchId =
        fromBoard && !taken.includes(fromBoard)
          ? fromBoard
          : ideaId(terms.name, taken);
      run({
        version: 3,
        author: me,
        launchId,
        salt: contributorSalt(me, launchId),
        chainId,
        kit: kit as string,
        expectedSummoner,
        founder: wallet.address.toLowerCase(),
        currency: currency as string,
        draft,
        dao: null,
        shares: null,
        createTx: null,
        recorded: false,
      });
    },
    [gate.ok, network.data, me, wallet.address, launches.data, run],
  );

  /** Carry on with a job from this visit or an earlier one. */
  const resume = useCallback(() => {
    if (job && wallet.address?.toLowerCase() === job.founder) run(job);
  }, [job, wallet.address, run]);

  /** Put a finished (or abandoned) job away so the form is fresh. */
  const clear = useCallback(() => {
    if (storageKey) storeJob(storageKey, null);
    setJob(null);
    setFlow(contributorFlow.initial());
  }, [storageKey]);

  const running = flow.phase === "running";
  const failedStep: ContributorStep | null = flow.failedStep;
  return {
    me,
    wallet,
    network: network.data ?? null,
    gate,
    job,
    flow,
    running,
    failedStep,
    start,
    resume,
    clear,
  };
}
