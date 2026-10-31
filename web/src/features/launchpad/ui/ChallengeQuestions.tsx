/**
 * Three questions against a vote, asked before it opens (`challenge.ts` in core, CHALLENGER-PLAN.md): what has to go
 * right, the strongest case against, and what else could be done. Each can be skipped. The answers are published with
 * the vote, so holders weigh the case against beside the proposal.
 */

import {
  type Challenge,
  type ChallengeAnswers,
  CHALLENGE_QUESTIONS,
} from "@creaton/core/launchpad/challenge.ts";

import { TextAreaField } from "./decision-fields";

export function ChallengeQuestions({
  value,
  onChange,
  notShown,
}: {
  value: ChallengeAnswers;
  onChange: (next: ChallengeAnswers) => void;
  /** Why holders would not see the answers from this account, when they would not. */
  notShown: string | null;
}) {
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
        {CHALLENGE_QUESTIONS.map((q) => (
          <div key={q.key}>
            <dt className="text-xs text-muted-foreground">{q.label}</dt>
            <dd>{challenge.answers[q.key] || "Skipped."}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
