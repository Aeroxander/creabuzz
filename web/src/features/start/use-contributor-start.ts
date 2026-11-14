/**
 * React wiring for starting a contributor project: which network, which contributor kit and currency it has, whether
 * the founder can send, and the run itself (`lib/contributor-flow.ts`) bound to the acting account (D139: a passkey
 * account with covered fees, or the browser's wallet), the chain and the server. The job is kept in this browser per founder, so a reload offers to finish it instead of starting over.
 */
import { useQuery } from "@tanstack/react-query";
import { isIdea } from "@/features/launchpad/lib/idea";
import { carryOnIssue, recordCarryingOver } from "./lib/from-idea";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { onPasskeySessionChange } from "@/features/identity/lib/passkey-identity";
import { investingOffered } from "@/features/launchpad/lib/investing-offered";

import {
  contributorKit,
  contributorKitV3,
  daoLaunchKit,
  ethCall,
  ethChainId,
  ethEstimateGas,
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
  fetchOwnRecord,
  useOwnLaunchIds,
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
  newAttempt,
  contributorTerms,
  daoMadeByKit,
  wordAddress,
} from "./lib/contributor-project";
import { readKitSale } from "./lib/weekly-sale";

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
  const removed = useRemovedLaunchIds(me);
  // The founder's own project ids, read by author to the end: the list of every project is cut at its newest records,
  // so an older project of theirs may be missing from it, and a new one must not take its id.
  const ownIds = useOwnLaunchIds(me);
  // Why the last press of Start made nothing (a project that could not carry on, or a read that failed).
  const [startError, setStartError] = useState<string | null>(null);
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
      // With investing on, a project is made by the pool kit, so none is left without a pool to open later; with it off the
      // kit is the one the build has always named. Setting up Shares never waits on either switch.
      const kit =
        (investingOffered() ? contributorKitV3(chainId) : null) ??
        contributorKit(chainId);
      const launchKit = daoLaunchKit(chainId);
      const currency = usdcAddress(chainId, localUsdcAddress());
      // Which launch this kit takes is read from the kit itself (`lib/weekly-sale.ts`); a node error fails the read.
      const [expectedSummoner, decimals, sale] = await Promise.all([
        launchKit
          ? ethCall(endpoint, launchKit, CALL_SUMMONER).then(wordAddress)
          : null,
        currency
          ? ethCall(endpoint, currency, CALL_DECIMALS).then((hex) =>
              Number(BigInt(hex.slice(0, 66))),
            )
          : null,
        kit
          ? readKitSale(
              (to, data) => ethCall(endpoint, to, data),
              kit,
              chainId,
              undefined,
              currency,
            )
          : { weekly: null, problem: null },
      ]);
      return {
        chainId,
        kit,
        expectedSummoner,
        currency,
        decimals,
        weekly: sale.weekly,
        kitProblem: sale.problem,
      };
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
    ownIds.isError || removed.isError
      ? "failed"
      : ownIds.isSuccess && removed.isSuccess
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
    void ownIds.refetch();
    void removed.refetch();
  }, [ownIds.refetch, removed.refetch]);

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
          madeByKit: (kit, dao) =>
            daoMadeByKit(
              {
                call: (to, data) => ethCall(endpoint, to, data),
                getLogs: (filter) => ethGetLogs(endpoint, filter),
              },
              kit,
              dao,
            ),
          // Asked live before the weekly-sale launch is sent: the node's own estimate, with its own timeout.
          estimateGas: (from, to, data) =>
            ethEstimateGas(endpoint, { from, to, data }),
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
            // The record is published over whatever the founder has under this id, so it starts from that record as
            // the server has it now: its cover, topic, story and rooms are kept. Read here, directly, never from a
            // remembered list (which may be old, cut short, or not read yet). A try that already published once reads
            // its own record back, so trying again keeps the board it made. If it cannot be read, nothing is
            // published: publishing blind would wipe those parts.
            const record = await recordCarryingOver(input, () =>
              fetchOwnRecord(start.author, input.id),
            );
            await publishWithProjectBoard({
              scope: boardScope,
              launchName: input.name,
              chat: record.chat ?? EMPTY_CHAT,
              save: async (chat) => {
                await create({ ...record, chat });
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
   * Projects-board project's id: the launch then takes that id, so the board links to it (D84). `fromIdea` is the
   * founder's own project without Shares: the launch keeps that id, so the project carries on as one.
   */
  const start = useCallback(
    async (
      draft: ContributorDraft,
      fromBoard?: string,
      fromIdea?: { id: string; name: string },
    ) => {
      if (!gate.ok || !network.data || !me || !wallet.address) return;
      if (!ownIds.data || !removed.data) return;
      setStartError(null);
      const { chainId, kit, expectedSummoner, currency, weekly } = network.data;
      const terms = contributorTerms(draft, wallet.address);
      if (fromIdea) {
        // Asked of the server now, by id: not of a list that may not hold the project.
        let own: Awaited<ReturnType<typeof fetchOwnRecord>>;
        try {
          own = await fetchOwnRecord(me, fromIdea.id);
        } catch {
          setStartError(
            `Couldn't read ${fromIdea.name} from the server, so Shares can't be set up for it yet. Nothing was made. Try again.`,
          );
          return;
        }
        const issue = carryOnIssue({
          name: fromIdea.name,
          own: own ? { isIdea: isIdea(own) } : null,
          everRemoved: removed.data.includes(fromIdea.id),
        });
        if (issue) {
          setStartError(issue);
          return;
        }
      }
      // Never an id the founder has or ever removed. The one kept on purpose is the project being carried on.
      const launchId = freshLaunchId({
        name: terms.name,
        fromBoard,
        fromIdea: fromIdea?.id,
        mine: fromIdea
          ? [...new Set([...ownIds.data, fromIdea.id])]
          : ownIds.data,
        removed: removed.data,
      });
      // A project asked to carry on keeps its id, or nothing is made: it never becomes a second project.
      if (fromIdea && launchId !== fromIdea.id) {
        setStartError(
          `Shares can't be set up for ${fromIdea.name} under its own id. Nothing was made. Try again.`,
        );
        return;
      }
      // Each try has its own part of the salt, so no two tries at one project share a DAO address.
      const attempt = newAttempt();
      run({
        version: 3,
        author: me,
        relay: relayWsUrl(),
        launchId,
        salt: contributorSalt(me, launchId, attempt),
        attempt,
        chainId,
        kit: kit as string,
        expectedSummoner,
        founder: wallet.address.toLowerCase(),
        currency: currency as string,
        ...(weekly
          ? {
              weekly: {
                quote: weekly.quote,
                ...(weekly.pool ? { pool: true as const } : {}),
              },
            }
          : {}),
        draft,
        dao: null,
        shares: null,
        createTx: null,
        recorded: false,
      });
    },
    [gate.ok, network.data, me, wallet.address, ownIds.data, removed.data, run],
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
    /** Why the last press of Start made nothing, in plain words, or null. */
    startError,
    rereadProjects,
    /** This browser's passkey identity is locked: nothing can be published under the founder's name until it is unlocked. */
    locked: me !== null && signingBlocked !== null,
  };
}
