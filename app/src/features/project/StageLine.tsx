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
 * The stages a project has actually reached. A project can skip a stage (a team without ever raising money), so a
 * stage before the current one is not done by its place in the line. Until the chain reader exists (milestone 5) no
 * money stage is ever reached here: the line never says a project was backed when it was not.
 */
function reachedStages(stage: Stage): ReadonlySet<Stage> {
  return new Set<Stage>(stage === "Team" ? ["Solo", "Team"] : ["Solo"]);
}

/**
 * The stage line: every stage, the current one lit, the ones reached faded green, the rest not reached. Only the
 * current stage and the single next step are spelled out (plan section 3). It also says what a stage does not prove.
 */
export function StageLine({
  stage,
  investing,
}: {
  stage: Stage;
  investing: boolean;
}) {
  const stages: readonly Stage[] = investing ? ALL_STAGES : NO_MONEY_STAGES;
  const reached = reachedStages(stage);
  return (
    <div className="flex flex-col gap-2" data-testid="stage-line">
      <ol aria-label="Stage" className="flex items-center gap-1.5">
        {stages.map((name) => {
          const current = name === stage;
          const done = !current && reached.has(name);
          return (
            <li
              aria-current={current ? "step" : undefined}
              className="flex flex-1 flex-col gap-1.5"
              data-reached={current ? "now" : done ? "done" : "no"}
              data-testid={`stage-${name.toLowerCase()}`}
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
                {current ? (
                  <span className="sr-only"> (now)</span>
                ) : done ? (
                  <span className="sr-only"> (done)</span>
                ) : (
                  <span className="sr-only"> (not reached)</span>
                )}
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
