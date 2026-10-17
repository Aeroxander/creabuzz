import { useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";

import { challengePublishBlock } from "./lib/challenge-copy";
import { challengeUpdateContent } from "./lib/challenge-evidence";
import { challengeEvidenceHash } from "./lib/challenge-evidence";
import { evidenceProblem } from "./lib/evidence";
import { encodeErc20Approve } from "./lib/evmCalls";
import {
  type ChallengeLockView,
  encodeChallengeFinish,
  encodeChallengeObject,
  encodeChallengeReleaseBond,
  encodeChallengeResolve,
  encodeChallengeSubmit,
  encodeChallengeVote,
} from "./lib/milestone-challenge";
import { hashText } from "./lib/work";
import type { Launch } from "./models";
import { getRpcEndpoint } from "./chain";
import { usePublishMirror } from "./use-launches";
import { endpointChain } from "./use-work";
import { useWalletSend } from "./use-wallet-send";

/**
 * What a person does to a milestone of a lock where holders can object, each as the transactions it takes: publish
 * (the evidence first, so holders can read it, then the bond, then the milestone), object (the deposit, then the
 * objection), vote, finish, settle, and take the bond back. Nothing here decides what is allowed: the screen offers
 * only what `challengeActions` says, and the contract refuses the rest.
 */
export function useChallengeActions(input: {
  launch: Launch;
  dao: string;
  view: ChallengeLockView;
  /** The exact words of each milestone, from the launch record, by position. */
  wordsOf: (index: number) => string | undefined;
}) {
  const { launch, dao, view, wordsOf } = input;
  const sender = useWalletSend(launch, dao);
  const publishUpdate = usePublishMirror().mutateAsync;
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const { terms, lock } = view;

  const run = async (key: string, steps: () => Promise<boolean>) => {
    if (working !== null || sender.busy !== null || sender.gate !== null) {
      return false;
    }
    setProblem(null);
    setWorking(key);
    try {
      return await steps();
    } finally {
      setWorking(null);
    }
  };

  /** Pay-in first: the lock pulls the bond or deposit itself, so it has to be allowed to. */
  const allow = async (key: string, amount: bigint): Promise<boolean> => {
    if (amount === 0n || terms.bondToken === null) return true;
    return sender.send(key, terms.bondToken, encodeErc20Approve(lock, amount));
  };

  return {
    sender,
    problem,
    working,
    blocked: working !== null || sender.busy !== null || sender.gate !== null,

    publish: (index: number, evidence: string) =>
      run(`challenge-publish-${index}`, async () => {
        const words = wordsOf(index);
        const milestone = view.milestones[index];
        if (!words || !milestone) {
          setProblem("This milestone's words are not on the launch record.");
          return false;
        }
        if (hashText(words).toLowerCase() !== milestone.checkHash) {
          setProblem(
            "The words on the launch record are not the ones the lock holds for this milestone, so it cannot be published from here.",
          );
          return false;
        }
        const wrong = evidenceProblem(evidence);
        if (wrong) {
          setProblem(wrong);
          return false;
        }
        // The lock would refuse it before the sale's claim block, or out of order, after the evidence and the bond approval had
        // already gone: ask the chain's current block first, so nothing is spent on a step that cannot succeed.
        let block: number;
        try {
          block = await endpointChain(getRpcEndpoint()).blockNumber();
        } catch {
          setProblem(
            "Could not check whether publishing is open yet, so nothing was sent. Try again.",
          );
          return false;
        }
        const closed = challengePublishBlock(index, terms, {
          block,
          previousStood:
            index === 0 || view.milestones[index - 1]?.phase === "stood",
        });
        if (closed) {
          setProblem(closed);
          return false;
        }
        // The text first: a holder cannot object to what they cannot read, and nothing is spent until it is out.
        try {
          await publishUpdate({
            kind: KIND_LAUNCH_UPDATE,
            author: launch.record.author,
            launchId: launch.record.id,
            content: challengeUpdateContent({
              milestone: index,
              evidence,
              check: words,
              lock,
            }),
          });
        } catch {
          setProblem(
            "The evidence could not be published, so nothing was sent to the lock. Try again.",
          );
          return false;
        }
        if (!(await allow(`challenge-approve-bond-${index}`, terms.bond))) {
          return false;
        }
        return sender.send(
          `challenge-submit-${index}`,
          lock,
          encodeChallengeSubmit(index, challengeEvidenceHash(evidence)),
        );
      }),

    object: (index: number) =>
      run(`challenge-object-${index}`, async () => {
        if (
          !(await allow(`challenge-approve-deposit-${index}`, terms.deposit))
        ) {
          return false;
        }
        return sender.send(
          `challenge-object-${index}`,
          lock,
          encodeChallengeObject(index),
        );
      }),

    vote: (index: number, reject: boolean) =>
      run(`challenge-vote-${index}`, () =>
        sender.send(
          `challenge-vote-${index}`,
          lock,
          encodeChallengeVote(index, reject),
        ),
      ),

    finish: (index: number) =>
      run(`challenge-finish-${index}`, () =>
        sender.send(
          `challenge-finish-${index}`,
          lock,
          encodeChallengeFinish(index),
        ),
      ),

    resolve: (index: number) =>
      run(`challenge-resolve-${index}`, () =>
        sender.send(
          `challenge-resolve-${index}`,
          lock,
          encodeChallengeResolve(index),
        ),
      ),

    releaseBond: (index: number) =>
      run(`challenge-release-${index}`, () =>
        sender.send(
          `challenge-release-${index}`,
          lock,
          encodeChallengeReleaseBond(index),
        ),
      ),
  };
}
