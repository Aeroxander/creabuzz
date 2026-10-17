import { CHALLENGE_DEFAULTS } from "../lib/dao-launch";
import { span } from "../lib/challenge-copy";
import { formatAtomic } from "../lib/amounts";
import type { PanelDraft, ReviewMode } from "../lib/launch-panel";
import { TextField } from "./decision-fields";
import { LaunchPanelFields } from "./LaunchPanelFields";

const CHOICES: { mode: ReviewMode; title: string; detail: string }[] = [
  {
    mode: "challenge",
    title: "Holders can object (recommended)",
    detail:
      "The team publishes evidence, holders get a week to object, and with no objection the tokens unlock. There are no reviewers to find or keep reachable.",
  },
  {
    mode: "panel",
    title: "Named reviewers",
    detail:
      "You name people outside your team now. They approve each milestone, and nobody can change them later.",
  },
];

/**
 * How the team's milestones are let through, chosen in the launch itself so backers see the rule before they buy and no
 * later vote can change it. Holders' objections need nothing from the founder but a bond; a panel needs people who agreed.
 */
export function LaunchReviewFields({
  draft,
  onChange,
  currencySymbol,
  currencyDecimals,
  requiredRaised,
  problem,
}: {
  draft: PanelDraft;
  onChange: (next: PanelDraft) => void;
  currencySymbol: string;
  currencyDecimals: number;
  /** The raise target in the sale currency's base units, as the record has it. */
  requiredRaised: string | null;
  /** What is wrong with the reviewers so far (panel only). */
  problem: string | null;
}) {
  const defaultBond =
    requiredRaised && /^\d+$/.test(requiredRaised)
      ? (BigInt(requiredRaised) * BigInt(CHALLENGE_DEFAULTS.bondBps)) / 10_000n
      : null;
  return (
    <div className="mt-3" data-testid="launch-review">
      <fieldset className="grid gap-2">
        <legend className="text-sm font-semibold">
          How your milestones unlock
        </legend>
        {CHOICES.map((choice) => (
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${
              draft.review === choice.mode
                ? "border-primary"
                : "border-black/10 dark:border-white/10"
            }`}
            key={choice.mode}
          >
            <input
              checked={draft.review === choice.mode}
              className="mt-1"
              data-testid={`launch-review-${choice.mode}`}
              name="launch-review"
              onChange={() => onChange({ ...draft, review: choice.mode })}
              type="radio"
            />
            <span>
              <span className="font-medium">{choice.title}</span>
              <span className="block text-muted-foreground">
                {choice.detail}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {draft.review === "challenge" ? (
        <div
          className="mt-3 grid gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
          data-testid="launch-challenge-fields"
        >
          <p className="text-sm text-muted-foreground">
            Each milestone waits {span(CHALLENGE_DEFAULTS.window)} for
            objections (longer for a bigger milestone, and longer again after
            each attempt holders turn down). A holder who objects starts a vote
            of holders; your team&apos;s own tokens do not count. The objection
            stands only if more is against the milestone than for it and at
            least {CHALLENGE_DEFAULTS.minRejectBps / 100}% of what could vote is
            against it; otherwise, including when nobody votes, the milestone
            stands. For {span(CHALLENGE_DEFAULTS.clawback)} after an unlock one
            more objection is possible, and if holders uphold it your remaining
            locked tokens are burned. Backers see all of this before they bid,
            and no vote can change it.
          </p>
          <TextField
            hint={
              defaultBond !== null
                ? `You post this with each milestone and get it back a month after the milestone unlocks, unless holders turn it down. Leave empty for ${formatAtomic(defaultBond, currencyDecimals, { maxFractionDigits: 2 })} ${currencySymbol}, 1% of your raise target.`
                : "You post this with each milestone and get it back a month after the milestone unlocks, unless holders turn it down. Leave empty for 1% of your raise target."
            }
            inputMode="decimal"
            label={`Bond you post with each milestone (${currencySymbol})`}
            onChange={(challengeBond) => onChange({ ...draft, challengeBond })}
            placeholder="Default"
            testId="launch-challenge-bond"
            value={draft.challengeBond}
          />
        </div>
      ) : (
        <LaunchPanelFields
          currencySymbol={currencySymbol}
          draft={draft}
          onChange={onChange}
          problem={problem}
        />
      )}
    </div>
  );
}
