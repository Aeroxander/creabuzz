import { CHALLENGE_DEFAULTS } from "@creaton/core/launchpad/daoLaunch.ts";
import { span } from "../lib/challenge-copy";
import { formatAtomic } from "../lib/amounts";
import {
  challengeWaits,
  type PanelDraft,
  type ReviewMode,
} from "../lib/launch-panel";
import { TextField } from "./decision-fields";
import { LaunchPanelFields } from "./LaunchPanelFields";

const CHOICES: { mode: ReviewMode; title: string; detail: string }[] = [
  {
    mode: "challenge",
    title: "Holders can object (recommended)",
    detail:
      "The team publishes evidence, holders get time to object, and with no objection anyone can finalize the unlock. There are no reviewers to find or keep reachable.",
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
  testNetwork,
}: {
  draft: PanelDraft;
  onChange: (next: PanelDraft) => void;
  currencySymbol: string;
  currencyDecimals: number;
  /** The raise target in the sale currency's base units, as the record has it. */
  requiredRaised: string | null;
  /** What is wrong with the reviewers so far (panel only). */
  problem: string | null;
  /** On a test network the founder may shorten the waits (D138); a real network keeps the defaults. */
  testNetwork: boolean;
}) {
  const waits = challengeWaits(draft, testNetwork);
  const bondBack =
    waits.clawback === 0
      ? "when the milestone unlocks"
      : `${span(waits.clawback)} after the milestone unlocks`;
  const defaultBond =
    requiredRaised && /^\d+$/.test(requiredRaised)
      ? (BigInt(requiredRaised) * BigInt(CHALLENGE_DEFAULTS.bondBps)) / 10_000n
      : null;
  // Illustration of the 20/30/50 split, using the same size scaling as windowFor.
  let earliest = 0;
  const exampleDays = [1, 2, 3].map((multiplier, index) => {
    earliest += waits.window * multiplier + (index ? waits.clawback : 0);
    return earliest / 86_400;
  });
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
          <div className="text-sm text-muted-foreground">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Each milestone waits {span(waits.window)} for objections (longer
                for a bigger milestone, and longer again after each attempt
                holders turn down).
              </li>
              <li>
                A holder who objects starts a vote of holders; your team&apos;s
                own Shares do not count. The objection stands only if more is
                against the milestone than for it and at least{" "}
                {CHALLENGE_DEFAULTS.minRejectBps / 100}% of what could vote is
                against it. Otherwise, including when nobody votes, the
                milestone stands.
              </li>
              <li>
                {waits.clawback === 0
                  ? "No objection is possible after an unlock."
                  : `For ${span(waits.clawback)} after an unlock one more objection is possible, and if holders uphold it your remaining locked Shares are burned.`}
              </li>
              <li>
                Milestones are published in order, and the next only once the
                one before has had its time for late objections. Until then, an
                upheld late objection can still burn the Shares behind the later
                milestones. Once the last one has unlocked, only your bond
                stands behind it.
              </li>
            </ul>
            <p className="mt-2" data-testid="launch-earliest-unlocks">
              For example, with a 20% / 30% / 50% milestone split, the earliest
              unlocks are days {exampleDays.join(", ")} after the first report,
              and you can reclaim the final bond on day{" "}
              {exampleDays[2] + waits.clawback / 86_400}. This assumes immediate
              publication when allowed, no objections or retries, and someone
              finalizing each unlock. Actual delivery and objections can make it
              take longer.
            </p>
            <p className="mt-2">
              Backers see all of this before they bid, and no vote can change
              it.
            </p>
          </div>
          <TextField
            hint={
              defaultBond !== null
                ? `You post this with each milestone and get it back ${bondBack}, unless holders turn it down. Leave empty for ${formatAtomic(defaultBond, currencyDecimals, { maxFractionDigits: 2 })} ${currencySymbol}, 1% of your raise target.`
                : `You post this with each milestone and get it back ${bondBack}, unless holders turn it down. Leave empty for 1% of your raise target.`
            }
            inputMode="decimal"
            label={`Bond you post with each milestone (${currencySymbol})`}
            onChange={(challengeBond) => onChange({ ...draft, challengeBond })}
            placeholder="Default"
            testId="launch-challenge-bond"
            value={draft.challengeBond}
          />
          {testNetwork ? (
            <div
              className="grid gap-2 rounded-lg bg-black/[0.03] p-3 dark:bg-white/[0.04]"
              data-testid="launch-challenge-waits"
            >
              <p className="text-sm font-medium">
                Shorter waits, for a test on this test network
              </p>
              <p className="text-xs text-muted-foreground">
                The same rules, with less time, so that a milestone test fits in
                weeks. Leave a field empty for its usual wait. A launch on a
                real network always uses the usual waits.
              </p>
              <TextField
                hint={`Usually ${span(CHALLENGE_DEFAULTS.window)}; 1 to 30.`}
                inputMode="numeric"
                label="Days a milestone waits for objections"
                onChange={(challengeWindow) =>
                  onChange({ ...draft, challengeWindow })
                }
                placeholder={String(CHALLENGE_DEFAULTS.window / 86_400)}
                testId="launch-challenge-window"
                value={draft.challengeWindow}
              />
              <TextField
                hint={`Usually ${span(CHALLENGE_DEFAULTS.votePeriod)}; 1 to 30.`}
                inputMode="numeric"
                label="Days a vote on an objection runs"
                onChange={(challengeVote) =>
                  onChange({ ...draft, challengeVote })
                }
                placeholder={String(CHALLENGE_DEFAULTS.votePeriod / 86_400)}
                testId="launch-challenge-vote"
                value={draft.challengeVote}
              />
              <TextField
                hint={`Usually ${span(CHALLENGE_DEFAULTS.clawback)}; 0 to 180. The next milestone can be published only after this.`}
                inputMode="numeric"
                label="Days late objections stay open after an unlock"
                onChange={(challengeLate) =>
                  onChange({ ...draft, challengeLate })
                }
                placeholder={String(CHALLENGE_DEFAULTS.clawback / 86_400)}
                testId="launch-challenge-late"
                value={draft.challengeLate}
              />
            </div>
          ) : null}
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
