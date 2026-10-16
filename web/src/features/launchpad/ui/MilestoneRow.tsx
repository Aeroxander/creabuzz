import { useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { formatAtomic } from "../lib/amounts";
import { evidenceProblem, evidenceUpdateContent } from "../lib/evidence";
import { encodeUnlock } from "../lib/milestone-lock";
import type { MilestoneTranche } from "../lib/milestone-lock";
import {
  claimForMilestone,
  MILESTONE_STEPS,
  milestoneClaimId,
  milestoneProgress,
} from "../lib/milestone-progress";
import {
  encodeBindMilestone,
  encodeCallId,
  encodeSetCheck,
  encodeSubmitPaidClaim,
  hashText,
  idLabel,
  idWord,
  SIGNATURES,
} from "../lib/work";
import type { WorkSnapshot } from "../lib/work-read";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });

/**
 * One of the team's milestones: the exact words it is judged by, where it stands (Submitted, Reviewing, Waiting period,
 * Ready to unlock, Unlocked) and the one thing the team member does next. Submitting files the claim in the DAO's
 * milestone panel with the milestone already chosen and publishes the evidence for the reviewers to read; nobody has to
 * copy the milestone's words or wait for a vote to take it on.
 */
export function MilestoneRow({
  tranche,
  words,
  wallet,
  lock,
  work,
  launch,
  busy,
  gate,
  onSend,
}: {
  tranche: MilestoneTranche;
  /** The exact words of the milestone from the launch record, when the record has them. */
  words: string | undefined;
  wallet: string;
  /** The lock's address. */
  lock: string;
  work: WorkSnapshot | undefined;
  launch: Launch;
  busy: string | null;
  gate: string | null;
  /** Sends one transaction; resolves true once it landed. */
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const panel = work?.mandates.find((m) => m.isMilestonePanel);
  const claim = panel
    ? claimForMilestone(panel.claims, wallet, tranche.checkHash)
    : null;
  const progress = milestoneProgress(
    claim,
    work?.chainTime ?? 0,
    panel?.challengeWindow ?? 0,
    tranche.unlocked,
  );
  const [evidence, setEvidence] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const publish = usePublishMirror();
  const key = `milestone-${tranche.index}`;
  const blocked = busy !== null || gate !== null || working;

  const finish = async () => {
    if (!panel || !claim) return;
    setWorking(true);
    try {
      // The waiting period is over: the claim is paid (nothing moves for a milestone), and the lock honours it.
      if (progress.stage === "finish") {
        const paid = await onSend(
          `${key}-payout`,
          panel.claimsAddress,
          encodeCallId(SIGNATURES.payout, claim.id),
        );
        if (!paid) return;
      }
      await onSend(
        `unlock-${tranche.index}`,
        lock,
        encodeUnlock(wallet, tranche.index, panel.address, claim.id),
      );
    } finally {
      setWorking(false);
    }
  };

  const submit = async () => {
    setProblem(null);
    if (!panel || !words) return;
    const wrong = evidenceProblem(evidence);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setWorking(true);
    try {
      const name = milestoneClaimId(
        tranche.index,
        panel.claims.map((c) => idLabel(c.id)),
      );
      const id = idWord(name);
      // Three steps to the wallet: file the claim, state which milestone it is for, send it to the panel's reviewers.
      if (
        !(await onSend(
          `${key}-file`,
          panel.claimsAddress,
          encodeSubmitPaidClaim(id, 0n, 0n, hashText(evidence)),
        ))
      ) {
        return;
      }
      if (
        !(await onSend(
          `${key}-check`,
          panel.claimsAddress,
          encodeSetCheck(id, tranche.checkHash),
        ))
      ) {
        return;
      }
      if (
        !(await onSend(`${key}-bind`, panel.address, encodeBindMilestone(id)))
      ) {
        return;
      }
      // The text itself, so the reviewers can read what was submitted.
      try {
        await publish.mutateAsync({
          kind: KIND_LAUNCH_UPDATE,
          author: launch.record.author,
          launchId: launch.record.id,
          content: evidenceUpdateContent({
            name,
            claimId: id,
            mandate: panel.address,
            evidence,
            check: words,
          }),
        });
      } catch {
        setProblem(
          "Submitted, but the evidence could not be published, and the reviewers cannot approve what they cannot read. Open the Work tab to publish it again.",
        );
        return;
      }
      setEvidence("");
    } finally {
      setWorking(false);
    }
  };

  const canSubmit =
    progress.stage === "not-submitted" || progress.stage === "turned-down";

  return (
    <li
      className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
      data-testid={`locked-shares-milestone-${tranche.index}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          Milestone {tranche.index + 1}: {shares(tranche.amount)} Shares
        </span>
        <span className="text-xs text-muted-foreground">
          {tranche.unlocked
            ? "Unlocked"
            : tranche.forfeited
              ? "Given up"
              : "Locked"}
        </span>
      </div>
      {words ? (
        <p className="mt-1 text-muted-foreground">
          Judged by: <code>{words}</code>
        </p>
      ) : null}
      {tranche.forfeited ? null : (
        <>
          <ol
            aria-label="Progress"
            className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"
            data-testid={`milestone-steps-${tranche.index}`}
          >
            {MILESTONE_STEPS.map((step, index) => (
              <li
                className={
                  index < progress.done
                    ? "text-emerald-700 dark:text-emerald-300"
                    : index === progress.done
                      ? "font-medium"
                      : "text-muted-foreground"
                }
                key={step}
              >
                {index < progress.done ? "✓ " : `${index + 1}. `}
                {step}
              </li>
            ))}
          </ol>
          <p
            className="mt-1 text-muted-foreground"
            data-testid={`milestone-stage-${tranche.index}`}
          >
            {progress.text}
          </p>
        </>
      )}
      {tranche.unlocked || tranche.forfeited ? null : (
        <div className="mt-2 grid gap-2">
          {canSubmit && words && panel ? (
            <>
              <label className="grid gap-1 text-xs">
                Evidence that this milestone was reached
                <textarea
                  className="min-h-16 rounded-md border border-black/10 bg-transparent p-1.5 text-sm dark:border-white/10"
                  data-testid={`milestone-evidence-${tranche.index}`}
                  onChange={(event) => setEvidence(event.target.value)}
                  placeholder="What shipped, with links the reviewers can open"
                  value={evidence}
                />
              </label>
              <div>
                <Button
                  aria-busy={working}
                  data-testid={`milestone-submit-${tranche.index}`}
                  disabled={blocked}
                  onClick={() => void submit()}
                  size="sm"
                  type="button"
                >
                  {working ? "Submitting…" : "Submit milestone evidence"}
                </Button>
              </div>
            </>
          ) : null}
          {canSubmit && (!words || !panel) ? (
            <p className="text-muted-foreground">
              {panel
                ? "This launch's record does not have the milestone's words, so it cannot be submitted from here."
                : "This launch has no milestone panel to submit to."}
            </p>
          ) : null}
          {progress.stage === "filed" && claim && panel ? (
            <Button
              data-testid={`milestone-send-${tranche.index}`}
              disabled={blocked}
              onClick={() =>
                void onSend(
                  `${key}-bind`,
                  panel.address,
                  encodeBindMilestone(claim.id),
                )
              }
              size="sm"
              type="button"
            >
              Finish submitting
            </Button>
          ) : null}
          {progress.stage === "reviewed" && claim && panel ? (
            <Button
              data-testid={`milestone-settle-${tranche.index}`}
              disabled={blocked}
              onClick={() =>
                void onSend(
                  `${key}-settle`,
                  panel.claimsAddress,
                  encodeCallId(SIGNATURES.settle, claim.id),
                )
              }
              size="sm"
              type="button"
            >
              Finish the review
            </Button>
          ) : null}
          {progress.stage === "finish" || progress.stage === "ready" ? (
            <Button
              aria-busy={working || busy === `unlock-${tranche.index}`}
              aria-label={`Unlock milestone ${tranche.index + 1}`}
              data-testid={`locked-shares-unlock-${tranche.index}`}
              disabled={blocked}
              onClick={() => void finish()}
              size="sm"
              type="button"
            >
              {working || busy === `unlock-${tranche.index}`
                ? "Unlocking…"
                : "Unlock"}
            </Button>
          ) : null}
          {problem ? (
            <p
              className="text-xs text-red-700 dark:text-red-300"
              data-testid={`milestone-problem-${tranche.index}`}
              role="alert"
            >
              {problem}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
