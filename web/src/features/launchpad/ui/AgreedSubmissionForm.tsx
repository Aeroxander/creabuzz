/**
 * The one way an accepted beneficiary sends their deliverable: keep the whole
 * attempt in this browser **before** the wallet is asked, send the chain steps
 * that are still missing as one ordered batch (the escrow claim at no currency
 * ask, then the agreed check, then the agreement's own binding), and publish
 * the evidence packet only once the chain has them — so a retried attempt
 * stays the same attempt, and a packet whose publish failed stays listed with
 * its "publish again" affordance instead of being lost.
 *
 * Reuses the pattern (`lib/claim-draft.ts`) and helpers (`lib/evidence.ts`)
 * the ordinary claim form runs on, pointed at the agreed lane
 * (`lib/agreed-submission.ts`).
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  decodeClaim,
  decodeWord,
  encodeCallId,
  hashText,
  SIGNATURES,
} from "@creaton/core/launchpad/work.ts";
import { encodeReadAgreementOfClaim } from "@creaton/core/launchpad/agreements.ts";
import type { AgreementRow } from "@creaton/core/launchpad/agreementsRead.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { ethCall, getRpcEndpoint } from "../chain";
import {
  agreedDraftKey,
  attemptIdOf,
  clearAgreedDraft,
  loadAgreedDraft,
  planBeneficiaryCalls,
  randomNonce,
  saveAgreedDraft,
  type AttemptRecord,
} from "../lib/agreed-submission";
import {
  evidenceProblem,
  evidenceUpdateContent,
  withSelfCheck,
  EVIDENCE_MAX_CHARS,
} from "../lib/evidence";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";

export function AgreedSubmissionForm({
  launch,
  mandate,
  row,
  claims,
  criteriaWords,
  deliverableLabel,
  wallet,
  gate,
  blocked,
  corrected,
  onSendBatch,
  onCloser,
}: {
  launch: Launch;
  mandate: string;
  /** The agreement record as the chain answered it (present). */
  row: AgreementRow & { kind: "present" };
  claims: string;
  /** The exact words the attempt states as its check, from the agreement. */
  criteriaWords?: string;
  deliverableLabel: string;
  wallet: string;
  gate: string | null;
  blocked: boolean;
  /** True for a corrected attempt: a new attempt record is asked for. */
  corrected?: boolean;
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
  /** Called once the send (and any later publish) succeeded, so the row refreshes. */
  onCloser: () => void;
}) {
  const terms = row.terms;
  const publish = usePublishMirror();
  const scopeKey = agreedDraftKey({
    server: relayWsUrl(),
    account: existingUserPubkey() ?? "",
    wallet,
    chainId: launch.record.chainId ?? "",
    mandate,
    agreementId: terms.id,
  });
  // The attempt this form is for: the record's next one. A copy kept for an
  // earlier attempt is not this attempt's, and is never reused as its ids.
  const nextAttempt = terms.attempts + 1;
  const stored = loadAgreedDraft(scopeKey);
  // A copy that says only its publish is left is this attempt's, whatever the
  // record's attempt count now says: the bind landed and the words did not.
  const kept =
    stored && (stored.attempt === nextAttempt || stored.pendingPublish === true)
      ? stored
      : null;
  // The words the attempt is judged against: the published ones, or the exact
  // copy this browser kept when it sent the attempt.
  const checkWords = kept?.criteriaWords ?? criteriaWords ?? "";
  const [nonce] = useState(() => kept?.nonce ?? randomNonce());
  const [artifact, setArtifact] = useState(kept?.artifact ?? "");
  const [met, setMet] = useState(kept?.met ?? "");
  const [notMet, setNotMet] = useState(kept?.notMet ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [pendingPublish, setPendingPublish] = useState(
    kept?.pendingPublish ?? false,
  );
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);

  const submitted = withSelfCheck(artifact, { met, notMet });
  const claimId =
    kept?.claimId ??
    attemptIdOf({ agreementId: terms.id, attempt: nextAttempt, nonce });

  // What the escrow already has under this exact attempt id, and whether the
  // agreement already names it: a retried send fills in only what is missing.
  const attemptRead = useQuery({
    queryKey: [
      "launchpad",
      "agreed-attempt",
      getRpcEndpoint(),
      mandate,
      terms.id,
      claims,
      claimId,
    ],
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
      const [claimHex, boundHex] = await Promise.all([
        ethCall(endpoint, claims, encodeCallId(SIGNATURES.claim, claimId)),
        ethCall(endpoint, mandate, encodeReadAgreementOfClaim(claimId)),
      ]);
      return {
        record: decodeClaim(claimHex) as AttemptRecord,
        bound: decodeWord(boundHex) !== 0n,
      };
    },
    staleTime: 5_000,
  });

  const publishEvidence = async () => {
    await publish.mutateAsync({
      kind: KIND_LAUNCH_UPDATE,
      author: launch.record.author,
      launchId: launch.record.id,
      content: evidenceUpdateContent({
        name: deliverableLabel,
        claimId,
        mandate,
        evidence: submitted,
        check: checkWords,
      }),
    });
  };

  const retryPublish = async () => {
    setProblem(null);
    setSending(true);
    try {
      const fresh = await attemptRead.refetch();
      if (fresh.error) {
        setProblem(
          "Could not read the chain for this attempt just now. Nothing was published; try again.",
        );
        return;
      }
      const record = fresh.data?.record ?? null;
      if (
        record &&
        record.evidenceHash.toLowerCase() !== hashText(submitted).toLowerCase()
      ) {
        setProblem(
          "The chain holds different text under this attempt, so this copy is not published over it. Leave the form as it is, or ask the project's manager to look at the attempt id below.",
        );
        return;
      }
      await publishEvidence();
      clearAgreedDraft(scopeKey);
      setPendingPublish(false);
      setDone(true);
      onCloser();
    } catch {
      setProblem(
        "Still could not publish. The attempt itself has not changed; press again to keep trying.",
      );
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    setProblem(null);
    setDone(false);
    if (checkWords.trim() === "") {
      setProblem(
        "The exact words this work is judged against are not at hand, so nothing was sent. Ask the work area's manager to publish them.",
      );
      return;
    }
    if (artifact.trim() === "") {
      setProblem("Say where the work is, so its reviewers can read it.");
      return;
    }
    if (submitted.length > EVIDENCE_MAX_CHARS) {
      const tooLong = evidenceProblem(submitted);
      if (tooLong) {
        setProblem(tooLong);
        return;
      }
    }
    if (met.trim() === "") {
      setProblem(
        "Say how you checked the work against the exact words: what you read, ran or compared.",
      );
      return;
    }
    setSending(true);
    try {
      // Read the chain now, so a half-landed earlier send is finished rather
      // than duplicated: the same attempt id is sent again, never a second one.
      const fresh = await attemptRead.refetch();
      if (fresh.error || !fresh.data) {
        setProblem(
          "Could not read the chain for this attempt just now, so nothing was sent. Try again.",
        );
        return;
      }
      const plan = planBeneficiaryCalls({
        claims,
        mandate,
        agreementId: terms.id,
        claimId,
        evidenceHash: hashText(submitted),
        criteriaHash: terms.criteriaHash,
        record: fresh.data.record,
        bound: fresh.data.bound,
      });
      if (plan.problem) {
        setProblem(plan.problem);
        return;
      }
      const draft = {
        agreementId: terms.id,
        mandate: mandate.toLowerCase(),
        chainId: launch.record.chainId ?? "",
        attempt: nextAttempt,
        nonce,
        claimId,
        artifact: artifact.trim(),
        met: met.trim(),
        notMet: notMet.trim(),
        criteriaWords: checkWords,
        pendingPublish: false,
      };
      if (!saveAgreedDraft(scopeKey, draft)) {
        setProblem(
          "Your browser would not keep a copy of this work, so nothing was sent. Your text stays in the form. Allow this site to store data, or free some space, and try again.",
        );
        return;
      }
      if (
        plan.calls.length > 0 &&
        !(await onSendBatch(`agreed-${terms.id.toLowerCase()}`, plan.calls))
      ) {
        setProblem(
          "The send to the chain did not finish. Nothing was lost. Press again to send what is still missing, under the same attempt.",
        );
        return;
      }
      // The chain steps landed: the kept copy now says only the publish is left,
      // so a reload shows the same visible retry instead of the form.
      saveAgreedDraft(scopeKey, { ...draft, pendingPublish: true });
      setPendingPublish(true);
      try {
        await publishEvidence();
      } catch {
        setProblem(
          "Your work landed, but its evidence could not be published, and reviewers cannot approve what they cannot read. Press Publish the evidence again to press the words through.",
        );
        return;
      }
      clearAgreedDraft(scopeKey);
      setPendingPublish(false);
      setDone(true);
      onCloser();
    } finally {
      setSending(false);
    }
  };

  if (pendingPublish) {
    return (
      <div className="mt-2 text-sm">
        <p data-testid="agreed-submission-pending-publish" role="status">
          The attempt went to the chain, but its evidence could not be
          published: reviewers cannot approve what they cannot read. A copy is
          kept in this browser.
        </p>
        <Button
          className="mt-2"
          data-testid="agreed-submission-retry-publish"
          disabled={blocked || sending}
          onClick={() => void retryPublish()}
          size="sm"
          type="button"
          variant="outline"
        >
          {sending ? "Publishing…" : "Publish the evidence again"}
        </Button>
        {problem ? (
          <p
            className="mt-2 text-sm text-red-700 dark:text-red-300"
            data-testid="agreed-submission-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2 grid gap-2">
      <p className="text-xs text-muted-foreground">
        This attempt asks for no money: the agreed quantity of Shares is already
        reserved. One press sends the claim, its check and its binding in order.
      </p>
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor="agreed-artifact-input">
          Where the work is
        </label>
        <Input
          data-testid="agreed-artifact"
          id="agreed-artifact-input"
          onChange={(event) => setArtifact(event.target.value)}
          placeholder="A link, or a short description"
          value={artifact}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor="agreed-met-input">
          How you checked it against the agreed words
        </label>
        <Input
          data-testid="agreed-met"
          id="agreed-met-input"
          onChange={(event) => setMet(event.target.value)}
          placeholder="What you read, ran or compared, and what you saw"
          value={met}
        />
        <span className="text-xs text-muted-foreground">
          Both are added to the work's evidence for its reviewers.
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor="agreed-not-met-input">
          Anything it does not meet yet (optional)
        </label>
        <Input
          data-testid="agreed-not-met"
          id="agreed-not-met-input"
          onChange={(event) => setNotMet(event.target.value)}
          placeholder="Saying it now is better than a turn-down later"
          value={notMet}
        />
        <span className="font-mono text-xs text-muted-foreground break-all">
          The attempt names its own id on the chain
          {kept ? " (kept in this browser)" : ""}:{" "}
          <code data-testid="agreed-attempt-id">{claimId}</code>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="agreed-submission-send"
          disabled={blocked || gate !== null || sending}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {sending
            ? "Sending…"
            : corrected
              ? "Submit the corrected attempt"
              : "Submit the deliverable"}
        </Button>
        {done ? (
          <span data-testid="agreed-submission-done" role="status">
            Submitted. The work waits for its reviewers now.
          </span>
        ) : null}
      </div>
      {problem ? (
        <p
          className="text-sm text-red-700 dark:text-red-300"
          data-testid="agreed-submission-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
