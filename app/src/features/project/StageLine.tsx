import type { StageName } from "../money/numbers-v1";
import { cn } from "../../ui/cn";

/** The stages of a project's life (plan section 3), in order. The money stages exist only where investing is on. */
const ALL_STAGES = ["Solo", "Backed", "Team", "Council", "Open"] as const;
const NO_MONEY_STAGES = ["Solo", "Team"] as const;
export type Stage = (typeof ALL_STAGES)[number];

/** What the server read from the chain about a project's money stage, when investing is on and it has a launch. */
export interface MoneyStage {
  stage: StageName;
  /** Total raised, in raw dollar units: above zero means Backed was reached, whatever came after. */
  raised: bigint;
}

const BY_NAME: Record<StageName, Stage> = {
  solo: "Solo",
  backed: "Backed",
  team: "Team",
  council: "Council",
  open: "Open",
};

/**
 * Where a project stands: Team once someone besides the founder has said yes on the record, Solo before; where the
 * server reads the project's launch (investing on), the chain's stage when it is further along.
 */
export function currentStage(
  acceptedMembers: number,
  money?: MoneyStage | null,
): Stage {
  const fromRecord: Stage = acceptedMembers > 0 ? "Team" : "Solo";
  if (!money) return fromRecord;
  const fromChain = BY_NAME[money.stage];
  return ALL_STAGES.indexOf(fromChain) > ALL_STAGES.indexOf(fromRecord)
    ? fromChain
    : fromRecord;
}

/**
 * The stages a project has actually reached. A project can skip a stage (a team without ever raising money), so a
 * stage before the current one is not done by its place in the line: Backed only when money came in, Council and Open
 * only when the chain says so. The line never says a project was backed when it was not.
 */
function reachedStages(
  stage: Stage,
  money?: MoneyStage | null,
): ReadonlySet<Stage> {
  const reached = new Set<Stage>(["Solo", stage]);
  if (money && money.raised > 0n) reached.add("Backed");
  if (stage === "Council" || stage === "Open") reached.add("Team");
  if (stage === "Open") reached.add("Council");
  return reached;
}

/**
 * The stage line: every stage, the current one lit, the ones reached faded green, the rest not reached. Only the
 * current stage and the single next step are spelled out (plan section 3). It also says what a stage does not prove.
 */
export function StageLine({
  stage,
  investing,
  money,
}: {
  stage: Stage;
  investing: boolean;
  money?: MoneyStage | null;
}) {
  const stages: readonly Stage[] = investing ? ALL_STAGES : NO_MONEY_STAGES;
  const reached = reachedStages(stage, investing ? money : null);
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
