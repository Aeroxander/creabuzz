import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { evidenceProblem, type EvidenceStanding } from "../lib/evidence";
import { hashText } from "../lib/work";
import type { ClaimView } from "../lib/work";

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

/**
 * A text with its web links made clickable. Only http and https links become anchors, and every anchor opens in a new
 * tab without handing the page over: evidence is written by someone else.
 */
function Linked({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, index) => {
        // Splitting on a capture group puts the links at the odd positions.
        const key = `${index}`;
        if (index % 2 === 0) return <span key={key}>{part}</span>;
        const link = part.replace(/[.,;:!?]+$/, "");
        const rest = part.slice(link.length);
        return (
          <span key={key}>
            <a
              className="break-all text-primary-ink underline-offset-4 hover:underline"
              href={link}
              rel="noopener noreferrer"
              target="_blank"
            >
              {link}
            </a>
            {rest}
          </span>
        );
      })}
    </>
  );
}

/**
 * What a reviewer reads before judging a claim: the evidence the contributor submitted and the words it is judged against,
 * shown only when they hash to what the claim committed to on the chain. When they are not at hand the reviewer is told
 * so, plainly, and cannot approve.
 */
export function EvidenceBlock({
  claim,
  standing,
  mine,
  onRepublish,
  onRetry,
  unreadable,
  incomplete = false,
  busy,
}: {
  claim: ClaimView;
  standing: EvidenceStanding;
  /** The connected wallet filed this claim: it may publish the evidence again. */
  mine: boolean;
  /** Publish the evidence again; resolves when it is on the server. */
  onRepublish: (evidence: string, check: string) => Promise<void>;
  busy: boolean;
  /** Looking for the evidence failed: say so, instead of claiming nothing was published. */
  unreadable: boolean;
  /** The launch has more updates than were read: "nothing found" may only mean "nothing found in the newest ones". */
  incomplete?: boolean;
  onRetry: () => void;
}) {
  const [evidence, setEvidence] = useState("");
  const [check, setCheck] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (standing.kind === "verified") {
    return (
      <div
        className="mt-2 rounded-md bg-black/5 p-2 text-sm dark:bg-white/5"
        data-testid="work-evidence"
      >
        <p className="text-xs font-medium text-muted-foreground">
          Evidence submitted
        </p>
        <p
          className="mt-1 whitespace-pre-wrap"
          data-testid="work-evidence-text"
        >
          <Linked text={standing.packet.evidence} />
        </p>
        {standing.packet.check ? (
          <>
            <p className="mt-2 text-xs font-medium text-muted-foreground">
              It is judged against
            </p>
            <p
              className="mt-1 whitespace-pre-wrap"
              data-testid="work-evidence-check"
            >
              {standing.packet.check}
            </p>
          </>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          This is the text the claim committed to on the network: it matches.
        </p>
      </div>
    );
  }

  if (unreadable) {
    return (
      <div
        className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        data-testid="work-evidence-unreadable"
        role="status"
      >
        <p>
          Could not look for the evidence just now, so it is not shown and this
          claim cannot be approved yet.
        </p>
        <Button
          className="mt-2"
          onClick={onRetry}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  }

  const republish = async () => {
    setProblem(null);
    const wrong = evidenceProblem(evidence);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    if (hashText(evidence) !== claim.record.evidenceHash.toLowerCase()) {
      setProblem(
        "That is not the text that was submitted with this claim. Paste it exactly as it was.",
      );
      return;
    }
    if (
      claim.record.checkHash !== `0x${"0".repeat(64)}` &&
      hashText(check) !== claim.record.checkHash.toLowerCase()
    ) {
      setProblem(
        "Those are not the words this claim is judged against. Paste them exactly as they were.",
      );
      return;
    }
    setSending(true);
    try {
      await onRepublish(evidence, check);
    } catch {
      setProblem("Couldn't publish it. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      data-testid="work-evidence-missing"
      role="status"
    >
      <p>
        {standing.kind === "mismatch"
          ? "Something was published for this claim, but it is not what the claim committed to. Do not approve it."
          : incomplete
            ? "No evidence for this claim was found in the updates this page reads. This project has more updates than that, so it may be in an older one. A reviewer cannot approve what they cannot read."
            : "No evidence has been published for this claim. A reviewer cannot approve what they cannot read."}
      </p>
      {mine ? (
        <div className="mt-2 grid gap-2">
          <label className="grid gap-1 text-xs">
            Evidence, exactly as you submitted it
            <textarea
              className="min-h-16 rounded-md border border-black/10 bg-white p-1.5 text-sm text-black dark:border-white/10 dark:bg-white/5 dark:text-white"
              data-testid="work-evidence-again"
              onChange={(event) => setEvidence(event.target.value)}
              value={evidence}
            />
          </label>
          <label className="grid gap-1 text-xs">
            The words it is judged against, exactly
            <textarea
              className="min-h-12 rounded-md border border-black/10 bg-white p-1.5 text-sm text-black dark:border-white/10 dark:bg-white/5 dark:text-white"
              data-testid="work-evidence-check-again"
              onChange={(event) => setCheck(event.target.value)}
              value={check}
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              data-testid="work-evidence-publish"
              disabled={busy || sending}
              onClick={() => void republish()}
              size="sm"
              type="button"
            >
              {sending ? "Publishing…" : "Publish the evidence"}
            </Button>
            {problem ? (
              <span
                className="text-xs text-red-700 dark:text-red-300"
                data-testid="work-evidence-problem"
                role="alert"
              >
                {problem}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
