/**
 * React wiring for starting a contributor project: which network, which contributor kit and currency it has, whether
 * the founder can send, and the run itself (`lib/contributor-flow.ts`) bound to the acting account (D139: a passkey
 * account with covered fees, or the browser's wallet), the chain and the server. The job is kept in this browser per founder, so a reload offers to finish it instead of starting over.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { onPasskeySessionChange } from "@/features/identity/lib/passkey-identity";

import {
  contributorKit,
  daoLaunchKit,
  ethCall,
  ethChainId,
  ethGetLogs,
  getRpcEndpoint,
  isContractDeployed,
  isMainnetChain,
  localUsdcAddress,
  mainnetEnabled,
  ethPendingNonce,
  networkLabel,
} from "@/features/launchpad/chain";
import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";
import {
  feesCoveredOn,
  passkeyChainId,
  StepRevertedError,
} from "@/features/launchpad/lib/acting-account";
import { useActingAccount } from "@/features/launchpad/use-acting-account";
import {
  useCreateLaunch,
  useLaunches,
  useRemovedLaunchIds,
} from "@/features/launchpad/use-launches";
import {
  EMPTY_CHAT,
  publishWithProjectBoard,
} from "@/features/launchpad/use-launch-chat";
import { endpointChain } from "@/features/launchpad/use-work";
import { existingUserPubkey } from "@/shared/lib/identity";
import { getUserSigningBlockedReason } from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type ContributorFlowState,
  type ContributorJob,
  type ContributorStep,
  assertJobCommunity,
  contributorFlow,
  JOB_STORAGE_PREFIX,
  jobBoardScope,
  parseJob,
  runContributorStart,
  stateForJob,
} from "./lib/contributor-flow";
import {
  type ContributorGate,
  canResume,
  contributorGate,
  freshLaunchId,
} from "./lib/contributor-gate";
import {
  CALL_DECIMALS,
  CALL_SUMMONER,
  type ContributorDraft,
  contributorSalt,
  contributorTerms,
  newDaoLogFilter,
  wordAddress,
} from "./lib/contributor-project";

export type { ContributorGate } from "./lib/contributor-gate";

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
  const wallet = useActingAccount();
  const launches = useLaunches();
  const removed = useRemovedLaunchIds(me);
  const create = useCreateLaunch().mutateAsync;
  // A passkey unlocked anywhere (here, the profile menu, the unlock overlay) changes what this page can do.
  const [, setSession] = useState(0);
  useEffect(() => onPasskeySessionChange(() => setSession((n) => n + 1)), []);
  const signingBlocked = getUserSigningBlockedReason();
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
  // The last failure's original words, for "Technical details" under the plain ones.
  const [failureDetails, setFailureDetails] = useState<string | null>(null);

  const projects: "reading" | "failed" | "read" =
    launches.isError || removed.isError
      ? "failed"
      : launches.isSuccess && removed.isSuccess
        ? "read"
        : "reading";
  const gate = useMemo<ContributorGate>(
    () =>
      contributorGate({
        network: {
          pending: network.isPending,
          failed: network.isError,
          data: network.data ?? null,
        },
        mainnetRefused: Boolean(
          network.data &&
            isMainnetChain(network.data.chainId) &&
            !mainnetEnabled(),
        ),
        me,
        signingBlocked,
        projects,
        wallet: { ...wallet, passkeyFeesOn: feesCoveredOn(passkeyChainId()) },
        label: networkLabel,
      }),
    [
      network.isPending,
      network.isError,
      network.data,
      me,
      signingBlocked,
      projects,
      wallet,
    ],
  );

  /** Read the founder's projects again, after a failed read or an unlock. */
  const rereadProjects = useCallback(() => {
    void launches.refetch();
    void removed.refetch();
  }, [launches.refetch, removed.refetch]);

  const run = useCallback(
    (start: ContributorJob) => {
      if (inFlight.current || !storageKey || !wallet.address) return;
      inFlight.current = true;
      // Kept before anything is sent: a reload during the first wallet prompt then offers to finish this project.
      storeJob(storageKey, start);
      setJob(start);
      setFailureDetails(null);
      let state = stateForJob(start);
      setFlow(state);
      const chain = endpointChain(endpoint);
      // Taken once for the run, so the board memo it writes is the one it reads back.
      const boardScope = jobBoardScope(start, relayWsUrl());
      void runContributorStart(
        start,
        {
          call: (to, data) => ethCall(endpoint, to, data),
          codeAt: (address) => isContractDeployed(endpoint, address),
          // Whether the kit's own DAO factory logged this DAO as made by the kit (a pre-summoned look-alike has no such log).
          madeByKit: async (kit, dao) => {
            const summoner = wordAddress(
              await ethCall(endpoint, kit, CALL_SUMMONER),
            );
            const logs = await ethGetLogs(endpoint, {
              ...newDaoLogFilter(summoner, kit, dao),
              fromBlock: "0x0",
              toBlock: "latest",
            });
            return logs.length > 0;
          },
          // The pending count: a budget another project is making in a block not yet mined is counted too.
          nonceOf: (address) => ethPendingNonce(endpoint, address),
          send: async (to, data) => {
            try {
              const txHash = await wallet.sendCalls(
                [{ to, data }],
                start.chainId,
              );
              return { txHash, status: "success" };
            } catch (error) {
              if (error instanceof StepRevertedError) {
                return { txHash: error.txHash, status: "reverted" };
              }
              throw error;
            }
          },
          now: () => chain.now(),
          // The project's board is made first (D156), so the record names it; a board that can't be made does
          // not stop the start, and the team opens it later from the Discussion tab.
          publish: async (input) => {
            assertJobCommunity(boardScope, relayWsUrl());
            await publishWithProjectBoard({
              scope: boardScope,
              launchName: input.name,
              chat: input.chat ?? EMPTY_CHAT,
              save: async (chat) => {
                await create({ ...input, chat });
              },
            });
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
      )
        .then((outcome) => {
          if (!outcome.ok) setFailureDetails(outcome.technical);
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [create, endpoint, storageKey, wallet.address, wallet.sendCalls],
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
      // Never a removed project's id: the DAO's address follows from it (the gate waits until both lists are read).
      const launchId = freshLaunchId({
        name: terms.name,
        fromBoard,
        mine: (launches.data ?? [])
          .filter((launch) => launch.record.author === me)
          .map((launch) => launch.record.id),
        removed: removed.data ?? [],
      });
      run({
        version: 3,
        author: me,
        relay: relayWsUrl(),
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
    [
      gate.ok,
      network.data,
      me,
      wallet.address,
      launches.data,
      removed.data,
      run,
    ],
  );

  /** Carry on with a job from this visit or an earlier one. */
  const resume = useCallback(() => {
    // Read the lock now: an unlock that just finished calls this before the page draws again.
    if (
      job &&
      canResume({
        job,
        wallet: wallet.address,
        signingBlocked: getUserSigningBlockedReason(),
      })
    ) {
      run(job);
    }
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
    failureDetails,
    rereadProjects,
    /** This browser's passkey identity is locked: nothing can be published under the founder's name until it is unlocked. */
    locked: me !== null && signingBlocked !== null,
  };
}
