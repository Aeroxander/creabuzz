/**
 * The founder's declaration about raising: the stance, who they want to hear
 * from, how they mean to fund it, and a rough date and note to go with it
 * (`lib/funding.ts`, plan §2–§3).
 *
 * One owner for the whole block — the record's `content.funding`. That is why
 * the funding *path* lives here rather than in the create wizard's steps: a
 * field with two owners drifts (Review-Proven Rule 7), and `content.funding`
 * is one field.
 *
 * Native field sets, radios and checkboxes, so keyboard and screen readers get
 * the group names and the stops for free (Review-Proven Rule 7).
 */

import type {
  FundingPath,
  FundingSeeking,
  FundingStance,
  FundingStatus,
} from "../lib/funding";
import {
  FUNDING_PATHS,
  FUNDING_PATH_HINTS,
  FUNDING_PATH_LABELS,
  FUNDING_SEEKING,
  FUNDING_SEEKING_LABELS,
  FUNDING_STANCES,
  FUNDING_STANCE_LABELS,
} from "../lib/funding";

const STANCE_HINTS: Record<FundingStance, string> = {
  "not-raising": "Self-funded or community-run.",
  planning: "You intend to raise, and you can say roughly when.",
  raising: "A sale is open right now.",
  closing: "Final stretch, or settling what was raised.",
  closed: "Raised, and not raising again.",
  rolling: "Ongoing or open-ended funding.",
};

/** The declaration as the record stores it; null means "nothing declared". */
function fundingFromForm(
  stance: FundingStance | null,
  seeking: readonly FundingSeeking[],
  path: FundingPath | null,
  opensAt: string,
  note: string,
): FundingStatus | null {
  if (stance === null) return null;
  return {
    stance,
    seeking: [...seeking],
    path,
    opensAt: opensAt.trim() === "" ? null : opensAt.trim(),
    note: note.trim() === "" ? null : note.trim(),
  };
}

export function FundingStatusEditor({
  value,
  onChange,
}: {
  value: FundingStatus | null;
  onChange(next: FundingStatus | null): void;
}) {
  const stance = value?.stance ?? null;
  const seeking = value?.seeking ?? [];
  const path = value?.path ?? null;
  const opensAt = value?.opensAt ?? "";
  const note = value?.note ?? "";

  // Every edit rewrites the one declaration: nothing is stored twice, so a
  // half-filled form can never reach the record as two competing answers.
  const update = (patch: {
    stance?: FundingStance;
    seeking?: FundingSeeking[];
    path?: FundingPath | null;
    opensAt?: string;
    note?: string;
  }) =>
    onChange(
      fundingFromForm(
        patch.stance ?? stance ?? "not-raising",
        patch.seeking ?? seeking,
        patch.path === undefined ? path : patch.path,
        patch.opensAt ?? opensAt,
        patch.note ?? note,
      ),
    );

  return (
    <section className="flex flex-col gap-3">
      <fieldset>
        <legend className="text-sm font-medium text-black dark:text-white">
          Funding status
        </legend>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          What you say here is what people see on every card. Say the same thing
          the money does.
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {FUNDING_STANCES.map((option) => (
            <label
              className="flex items-start gap-2 text-sm text-black dark:text-white"
              key={option}
            >
              <input
                checked={stance === option}
                className="mt-1"
                name="funding-stance"
                onChange={() => update({ stance: option })}
                type="radio"
                value={option}
              />
              <span>
                <span className="font-medium">
                  {FUNDING_STANCE_LABELS[option]}
                </span>
                <span className="block text-xs text-black/60 dark:text-white/60">
                  {STANCE_HINTS[option]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-black dark:text-white">
          How do you want to fund this?
        </legend>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          Each one turns on as its contract is ready. You can change this before
          you go live.
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {FUNDING_PATHS.map((option) => (
            <label
              className="flex items-start gap-2 text-sm text-black dark:text-white"
              key={option}
            >
              <input
                checked={path === option}
                className="mt-1"
                name="funding-path"
                onChange={() => update({ path: option })}
                type="radio"
                value={option}
              />
              <span>
                <span className="font-medium">
                  {FUNDING_PATH_LABELS[option]}
                </span>
                <span className="block text-xs text-black/60 dark:text-white/60">
                  {FUNDING_PATH_HINTS[option]}
                </span>
              </span>
            </label>
          ))}
          <label
            className="flex items-start gap-2 text-sm text-black dark:text-white"
            key="none"
          >
            <input
              checked={path === null}
              className="mt-1"
              name="funding-path"
              onChange={() => update({ path: null })}
              type="radio"
              value="none"
            />
            <span>
              <span className="font-medium">Not decided yet</span>
              <span className="block text-xs text-black/60 dark:text-white/60">
                Choose a path before you ask anyone for money.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-black dark:text-white">
          Who are you looking for?
        </legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
          {FUNDING_SEEKING.map((wanted) => (
            <label
              className="flex items-center gap-2 text-sm text-black dark:text-white"
              key={wanted}
            >
              <input
                checked={seeking.includes(wanted)}
                onChange={() =>
                  update({
                    seeking: seeking.includes(wanted)
                      ? seeking.filter((s) => s !== wanted)
                      : [...seeking, wanted],
                  })
                }
                type="checkbox"
                value={wanted}
              />
              {FUNDING_SEEKING_LABELS[wanted]}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          A project can be not raising and still want contributors.
        </p>
      </fieldset>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-black dark:text-white">
          When might it open?
          <input
            className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm font-normal dark:border-white/15"
            max="2100-12-31"
            onChange={(e) => update({ opensAt: e.target.value })}
            type="date"
            value={opensAt}
          />
        </label>
        <label className="flex flex-[2] flex-col gap-1 text-sm font-medium text-black dark:text-white">
          Anything to add?
          <input
            className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm font-normal dark:border-white/15"
            maxLength={140}
            onChange={(e) => update({ note: e.target.value })}
            placeholder="A sentence people read beside the status."
            type="text"
            value={note}
          />
        </label>
      </div>
    </section>
  );
}
