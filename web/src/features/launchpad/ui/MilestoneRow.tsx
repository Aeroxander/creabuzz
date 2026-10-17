import { useEffect, useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { formatAtomic } from "../lib/amounts";
import {
  evidenceFor,
  evidenceProblem,
  evidenceUpdateContent,
} from "../lib/evidence";
import {
  claimForDraft,
  clearSubmission,
  loadSubmission,
  type RemainingSteps,
  remainingSteps,
  type SubmissionDraft,
  saveSubmission,
  submissionKey,
  type SubmitStep,
} from "../lib/milestone-submission";
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
import { useEvidencePackets } from "../use-evidence";
import { usePublishMirror } from "../use-launches";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });

/** What each step of a submission is, for the sentence that says what is left. */
const STEP_WORDS: Record<SubmitStep, string> = {
  file: "file the claim",
  check: "state which milestone it is for",
  bind: "send it to the reviewers",
  publish: "publish the evidence",
};

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
  // A submission that was started and not finished is kept, so cancelling a prompt or reloading resumes the same one.
  const storageKey = submissionKey(lock, wallet, tranche.index);
  const [draft, setDraft] = useState<SubmissionDraft | null>(() =>
    loadSubmission(storageKey),
  );
  const { packets } = useEvidencePackets(launch);
  const pending = claimForDraft(panel?.claims ?? [], draft, wallet);
  const claim =
    (panel
      ? claimForMilestone(panel.claims, wallet, tranche.checkHash)
      : null) ?? pending;
  const progress = milestoneProgress(
    claim,
    work?.chainTime ?? 0,
    panel?.challengeWindow ?? 0,
    tranche.unlocked,
  );
  const left: RemainingSteps | null =
    draft && panel
      ? remainingSteps({
          draft,
          claim: pending,
          checkHash: tranche.checkHash,
          published:
            pending !== null &&
            evidenceFor(pending, packets, panel.address).kind === "verified",
        })
      : null;
  const [evidence, setEvidence] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const publish = usePublishMirror();
  const key = `milestone-${tranche.index}`;
  const blocked = busy !== null || gate !== null || working;

  // Everything the saved submission needed is done: nothing is left to keep.
  useEffect(() => {
    if (left && "steps" in left && left.steps.length === 0) {
      clearSubmission(storageKey);
      setDraft(null);
    }
  }, [left, storageKey]);

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

  /** Do what is left of a submission, in order, stopping at the first thing that does not go through. */
  const proceed = async (saved: SubmissionDraft) => {
    setProblem(null);
    if (!panel || !words) return;
    const filed = claimForDraft(panel.claims, saved, wallet);
    const remaining = remainingSteps({
      draft: saved,
      claim: filed,
      checkHash: tranche.checkHash,
      published:
        filed !== null &&
        evidenceFor(filed, packets, panel.address).kind === "verified",
    });
    if ("problem" in remaining) {
      setProblem(remaining.problem);
      return;
    }
    const id = idWord(saved.name);
    setWorking(true);
    try {
      for (const step of remaining.steps) {
        if (step === "publish") {
          // The text itself, so the reviewers can read what was submitted.
          try {
            await publish.mutateAsync({
              kind: KIND_LAUNCH_UPDATE,
              author: launch.record.author,
              launchId: launch.record.id,
              content: evidenceUpdateContent({
                name: saved.name,
                claimId: id,
                mandate: panel.address,
                evidence: saved.evidence,
                check: words,
              }),
            });
          } catch {
            setProblem(
              "Submitted, but the evidence could not be published, and the reviewers cannot approve what they cannot read. Your submission is saved: press Continue to publish it.",
            );
            return;
          }
          continue;
        }
        const landed =
          step === "file"
            ? await onSend(
                `${key}-file`,
                panel.claimsAddress,
                encodeSubmitPaidClaim(id, 0n, 0n, hashText(saved.evidence)),
              )
            : step === "check"
              ? await onSend(
                  `${key}-check`,
                  panel.claimsAddress,
                  encodeSetCheck(id, tranche.checkHash),
                )
              : await onSend(
                  `${key}-bind`,
                  panel.address,
                  encodeBindMilestone(id),
                );
        if (!landed) {
          setProblem(
            "It stopped before the end. Your submission is saved: press Continue to finish it.",
          );
          return;
        }
      }
      clearSubmission(storageKey);
      setDraft(null);
      setEvidence("");
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
    const saved = {
      name: milestoneClaimId(
        tranche.index,
        panel.claims.map((c) => idLabel(c.id)),
      ),
      evidence,
    };
    // Saved before the first prompt, so a cancel or a reload finds it.
    saveSubmission(storageKey, saved);
    setDraft(saved);
    await proceed(saved);
  };

  const resuming =
    draft !== null &&
    left !== null &&
    !("steps" in left && left.steps.length === 0);
  const canSubmit =
    !resuming &&
    (progress.stage === "not-submitted" || progress.stage === "turned-down");

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
          {resuming && draft && panel ? (
            <div
              className="grid gap-2 rounded-md bg-black/5 p-2 dark:bg-white/5"
              data-testid={`milestone-resume-${tranche.index}`}
            >
              <p>
                {left && "steps" in left
                  ? `Your last submission is not finished. Still to do: ${left.steps.map((step) => STEP_WORDS[step]).join(", then ")}.`
                  : "Your last submission cannot be continued."}
              </p>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {draft.evidence}
              </p>
              <div className="flex flex-wrap gap-2">
                {left && "steps" in left ? (
                  <Button
                    aria-busy={working}
                    data-testid={`milestone-continue-${tranche.index}`}
                    disabled={blocked}
                    onClick={() => void proceed(draft)}
                    size="sm"
                    type="button"
                  >
                    {working ? "Submitting…" : "Continue submitting"}
                  </Button>
                ) : null}
                <Button
                  data-testid={`milestone-start-over-${tranche.index}`}
                  disabled={blocked}
                  onClick={() => {
                    clearSubmission(storageKey);
                    setDraft(null);
                    setProblem(null);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Start over
                </Button>
              </div>
            </div>
          ) : null}
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
          {progress.stage === "filed" && claim && panel && !resuming ? (
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
