import { cn } from "../../ui/cn";

/** The stages of a project's life (plan section 3), in order. The money stages exist only where investing is on. */
const ALL_STAGES = ["Solo", "Backed", "Team", "Council", "Open"] as const;
const NO_MONEY_STAGES = ["Solo", "Team"] as const;
export type Stage = (typeof ALL_STAGES)[number];

/**
 * Where a project stands, as far as this app can read without the chain: Team once someone besides the founder has
 * said yes on the record, Solo before. The money stages (Backed, Council, Open) need the chain reader (milestone 5).
 */
export function currentStage(acceptedMembers: number): Stage {
  return acceptedMembers > 0 ? "Team" : "Solo";
}

/**
 * The stage line: every stage, the current one lit, the next one named. Only the current stage and the single next
 * step are spelled out (plan section 3). It also says what a stage does not prove.
 */
export function StageLine({
  stage,
  investing,
}: {
  stage: Stage;
  investing: boolean;
}) {
  const stages: readonly Stage[] = investing ? ALL_STAGES : NO_MONEY_STAGES;
  const at = stages.indexOf(stage);
  return (
    <div className="flex flex-col gap-2" data-testid="stage-line">
      <ol aria-label="Stage" className="flex items-center gap-1.5">
        {stages.map((name, index) => {
          const done = index < at;
          const current = index === at;
          return (
            <li
              aria-current={current ? "step" : undefined}
              className="flex flex-1 flex-col gap-1.5"
              key={name}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 rounded-full",
                  current ? "bg-mint" : done ? "bg-mint/50" : "bg-white/18",
                )}
              />
              <span
                className={cn(
                  "text-2xs font-semibold",
                  current ? "text-ink" : "text-muted",
                )}
              >
                {name}
                {current ? <span className="sr-only"> (now)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">
        A stage says what a project has done, not that anyone checked it.
      </p>
    </div>
  );
}
