import { useContributionRecordsQuery } from "../hooks";
import { countLadderOutcomes, resolveLadder } from "../lib/ladder";
import type { OrgBudget } from "../orgModels";

type OrgBudgetLadderProps = {
  budget: OrgBudget;
};

const WINDOW_LABEL: Record<OrgBudget["window"], string> = {
  day: "this day",
  week: "this week",
  month: "this month",
  epoch: "all time",
};

/**
 * Performance-linked autonomy (NIP-ORG § Performance-linked autonomy):
 * shows the budget's escalation ladder, the active tier resolved against
 * the subject's accepted contribution records, and the violation state.
 * Pure client-side resolution over the org events the desktop already
 * reads (canonical records; window math mirrors the relay's).
 */
export function OrgBudgetLadder({ budget }: OrgBudgetLadderProps) {
  // Hooks before any early return (rules of hooks).
  const contributions = useContributionRecordsQuery();
  const nowSecs = Math.floor(Date.now() / 1000);

  const link = budget.performanceLink;
  if (!link) return null;

  if (contributions.isPending) {
    return (
      <p className="mt-1.5 text-2xs text-muted-foreground">Checking ladder…</p>
    );
  }
  if (contributions.isError || !contributions.data) {
    return (
      <p className="mt-1.5 text-2xs text-muted-foreground">Ladder unavailable</p>
    );
  }

  const counts = countLadderOutcomes(
    budget.subject,
    link,
    contributions.data,
    nowSecs,
  );
  const resolution = resolveLadder(link, counts, budget.limits);
  const maxTier = link.tiers.length;

  const tierLabel =
    resolution.tier === null
      ? `base (0/${maxTier} tiers)`
      : `tier ${resolution.tier + 1} of ${maxTier}`;

  return (
    <div className="mt-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Performance ladder · {link.window}
      </p>
      {resolution.violated ? (
        <p
          className="mt-1 text-2xs font-medium text-red-400"
          data-testid="org-ladder-violation"
        >
          {resolution.zeroed
            ? `Violated — autonomy zeroed (${link.onViolation}) until the window heals.`
            : "Violated — limits dropped to base until the window heals."}
        </p>
      ) : (
        <p className="mt-1 text-2xs">
          <span className="font-medium text-foreground">{tierLabel}</span>
          <span className="text-muted-foreground">
            {" "}· {counts.accepted} accepted {WINDOW_LABEL[link.window]}
            {resolution.nextTierMin !== null
              ? ` · ${Math.max(0, resolution.nextTierMin - counts.accepted)} more to unlock the next`
              : " · top tier reached"}
          </span>
        </p>
      )}
      <ul className="mt-1 space-y-0.5">
        {link.tiers.map((tier, i) => {
          const active = !resolution.violated && resolution.tier === i;
          const runCeiling = tier.limits.runs;
          return (
            <li
              key={tier.minAccepted}
              className="text-2xs text-muted-foreground"
              data-active-tier={active || undefined}
            >
              {active ? "▸ " : "  "}
              {tier.minAccepted}+ accepted →{runCeiling !== undefined ? ` ${runCeiling} runs` : ""}
              {tier.limits.tasks?.create !== undefined
                ? ` · ${tier.limits.tasks.create} tasks`
                : ""}
            </li>
          );
        })}
        <li className="text-2xs text-muted-foreground">
          {"  "}base → {budget.limits.runs !== undefined
            ? ` ${budget.limits.runs} runs`
            : ""}
          {budget.limits.tasks?.create !== undefined
            ? ` · ${budget.limits.tasks.create} tasks`
            : ""}
        </li>
      </ul>
      {link.violationThreshold !== undefined ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {link.onViolation === "revoke"
            ? `One rejected record ${WINDOW_LABEL[link.window]} revokes autonomy.`
            : `${link.violationThreshold.rejected}+ rejected record${
                link.violationThreshold.rejected > 1 ? "s" : ""
              } ${WINDOW_LABEL[link.window]} triggers ${link.onViolation}.`}
        </p>
      ) : null}
    </div>
  );
}
