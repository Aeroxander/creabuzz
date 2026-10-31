/**
 * Three questions against a vote, asked before it opens (`challenge.ts` in core, CHALLENGER-PLAN.md): what has to go
 * right, the strongest case against, and what else could be done. Each can be skipped. The answers are published with
 * the vote, so holders weigh the case against beside the proposal.
 */

import {
  type Challenge,
  type ChallengeAnswers,
  type ChallengeExtras,
  CHALLENGE_QUESTIONS,
} from "@creaton/core/launchpad/challenge.ts";

import {
  type ChallengeContext,
  challengeSummaryPrompt,
  followUpPrompt,
  parseChallengeSummary,
  parseFollowUps,
} from "@creaton/core/launchpad/challengeAi.ts";
import { useLlmGateway } from "@/features/fleet/use-llm-gateway";
import { Button } from "@/shared/ui/button";
import { useState } from "react";

import { askAi } from "../ask-ai";
import type { Launch } from "../models";
import { useCheckNotes } from "../use-check-notes";
import { useProjectFocus } from "../use-project-structure";
import { TextAreaField } from "./decision-fields";

export function ChallengeQuestions({
  value,
  onChange,
  notShown,
  launch,
  kindLabel,
  extras,
  onExtras,
  summaryToRead,
  onSummaryToRead,
  onSummaryRead,
}: {
  value: ChallengeAnswers;
  onChange: (next: ChallengeAnswers) => void;
  /** Why holders would not see the answers from this account, when they would not. */
  notShown: string | null;
  launch: Launch;
  /** The kind of vote, in words, for the AI. */
  kindLabel: string;
  /** The AI's follow-ups and the summary (CHALLENGER-PLAN.md step 2). */
  extras: ChallengeExtras;
  onExtras: (next: ChallengeExtras) => void;
  /** The summary was drafted by the AI and not yet read. */
  summaryToRead: boolean;
  onSummaryToRead: () => void;
  onSummaryRead: () => void;
}) {
  // The AI's part, offered only when the server's AI service is on. It sees the answers, the kind of vote, the aim, Now
  // and the latest check note.
  const gateway = useLlmGateway();
  const focus = useProjectFocus(launch);
  const notes = useCheckNotes(launch);
  const [asking, setAsking] = useState<"follow-ups" | "summary" | null>(null);
  const [aiFailure, setAiFailure] = useState<string | null>(null);
  const context: ChallengeContext = {
    kind: kindLabel,
    aim: focus.query.data?.aim ?? "",
    now: (focus.query.data?.now ?? []).map((n) => n.text),
    lastCheck: notes.query.data?.[0]
      ? {
          outside: notes.query.data[0].outside,
          change: notes.query.data[0].change,
        }
      : null,
  };
  const ask = async (what: "follow-ups" | "summary") => {
    setAsking(what);
    setAiFailure(null);
    try {
      if (what === "follow-ups") {
        const prompt = followUpPrompt(context, value);
        const questions = parseFollowUps(
          await askAi(prompt.system, prompt.user),
        );
        if (!questions) throw new Error("unreadable");
        onExtras({
          ...extras,
          followUps: questions.map((question) => ({ question, answer: "" })),
        });
      } else {
        const prompt = challengeSummaryPrompt(context, value, extras.followUps);
        const summary = parseChallengeSummary(
          await askAi(prompt.system, prompt.user),
        );
        if (!summary) throw new Error("unreadable");
        onExtras({ ...extras, summary });
        onSummaryToRead();
      }
    } catch (error) {
      setAiFailure(
        error instanceof Error && error.message !== "unreadable"
          ? error.message
          : "The AI's answer could not be read. Try again, or carry on without it.",
      );
    } finally {
      setAsking(null);
    }
  };
  return (
    <fieldset
      className="mt-3 flex flex-col gap-2 rounded-lg bg-secondary/40 p-3"
      data-testid="decision-challenge"
    >
      <legend className="px-1 text-sm font-semibold">
        Before it goes out: argue against it
      </legend>
      <p className="text-xs text-muted-foreground">
        A minute spent on the case against makes a better decision. Holders see
        your answers beside the vote. Any question can be skipped, but the vote
        then shows which ones were.
      </p>
      {CHALLENGE_QUESTIONS.map((q) => (
        <TextAreaField
          hint={q.hint}
          key={q.key}
          label={q.label}
          onChange={(text) => onChange({ ...value, [q.key]: text })}
          rows={2}
          testId={`decision-challenge-${q.key}`}
          value={value[q.key]}
        />
      ))}
      {extras.followUps.map((f, i) => (
        <TextAreaField
          hint="Asked by the AI. Answer or leave it empty to skip."
          key={f.question}
          label={f.question}
          onChange={(answer) =>
            onExtras({
              ...extras,
              followUps: extras.followUps.map((g, j) =>
                j === i ? { ...g, answer } : g,
              ),
            })
          }
          rows={2}
          testId={`decision-challenge-followup-${i}`}
          value={f.answer}
        />
      ))}
      {extras.summary || summaryToRead ? (
        <div className="flex flex-col gap-1">
          <TextAreaField
            hint={
              summaryToRead
                ? "Drafted by the AI from your answers. Fix anything that is wrong, then keep it."
                : undefined
            }
            label="Summary"
            onChange={(summary) => {
              onExtras({ ...extras, summary });
              onSummaryRead();
            }}
            rows={3}
            testId="decision-challenge-summary"
            value={extras.summary}
          />
          {summaryToRead ? (
            <Button
              className="w-fit"
              data-testid="decision-challenge-summary-accept"
              onClick={onSummaryRead}
              size="sm"
              type="button"
              variant="outline"
            >
              I&apos;ve read it: keep this summary
            </Button>
          ) : null}
        </div>
      ) : null}
      {gateway === "available" ? (
        <div className="flex flex-wrap items-center gap-2">
          {extras.followUps.length === 0 ? (
            <Button
              aria-busy={asking === "follow-ups"}
              data-testid="decision-challenge-ai-ask"
              disabled={asking !== null}
              onClick={() => void ask("follow-ups")}
              size="sm"
              type="button"
              variant="outline"
            >
              {asking === "follow-ups"
                ? "Asking the AI…"
                : "Have the AI press on your answers"}
            </Button>
          ) : null}
          <Button
            aria-busy={asking === "summary"}
            data-testid="decision-challenge-ai-summary"
            disabled={asking !== null}
            onClick={() => void ask("summary")}
            size="sm"
            type="button"
            variant="outline"
          >
            {asking === "summary" ? "Drafting…" : "Draft a summary with AI"}
          </Button>
          <span className="text-xs text-muted-foreground">
            It sees your answers, the project&apos;s aim, Now and the latest
            check note. It decides nothing.
          </span>
        </div>
      ) : null}
      {aiFailure ? (
        <p
          className="text-xs text-destructive"
          data-testid="decision-challenge-ai-failed"
          role="alert"
        >
          {aiFailure}
        </p>
      ) : null}
      {notShown ? (
        <p
          className="text-xs text-amber-800 dark:text-amber-300"
          data-testid="decision-challenge-unlinked"
          role="status"
        >
          {notShown}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * On a vote that commits money or Shares: the case against it, as the person who opened it answered before it went out,
 * or that it was not challenged. Nothing while the challenges are still being read.
 */
export function ChallengeBrief({
  challenge,
  read,
}: {
  challenge: Challenge | null;
  read: boolean;
}) {
  if (!read) return null;
  if (!challenge) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="decision-not-challenged"
      >
        Not challenged before it went out: whoever opened it did not say what
        argues against it.
      </p>
    );
  }
  return (
    <details className="text-sm" data-testid="decision-challenged">
      <summary className="cursor-pointer text-xs font-medium">
        Challenged before it went out: read the case against
      </summary>
      <dl className="mt-1 flex flex-col gap-1 rounded-md bg-secondary/40 p-2">
        {challenge.summary ? (
          <div>
            <dt className="text-xs text-muted-foreground">Summary</dt>
            <dd data-testid="decision-challenged-summary">
              {challenge.summary}
            </dd>
          </div>
        ) : null}
        {CHALLENGE_QUESTIONS.map((q) => (
          <div key={q.key}>
            <dt className="text-xs text-muted-foreground">{q.label}</dt>
            <dd>{challenge.answers[q.key] || "Skipped."}</dd>
          </div>
        ))}
        {challenge.followUps.map((f) => (
          <div key={f.question}>
            <dt className="text-xs text-muted-foreground">
              {f.question} (asked by the AI)
            </dt>
            <dd>{f.answer || "Skipped."}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
