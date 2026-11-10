/**
 * A project's goal, right under its name: the goal in the founder's words, how everyone will know it was reached, the
 * shorter goals under it, and what became of earlier ones.
 *
 * The founder sets and updates goals here. Marking a goal missed or changed, or rewording it, adds to its history,
 * which anyone can open; nothing here edits or removes a goal. (A founder can still delete their own records on the
 * server; the card below says how many they have deleted.)
 *
 * It is read from the project's own records (`useProjectRecord`). A read that failed says so with a way to read again;
 * a read that was cut short never says "no goal".
 */

import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import {
  GOAL_LEVEL_LABEL,
  GOAL_STATE_LABEL,
  type GoalInput,
  type GoalState,
  type GoalView,
  goalStepWord,
} from "../lib/goals";
import type { Launch } from "../models";
import { useProjectRecord, useSaveGoal } from "../use-project-record";
import { GoalDialog, type GoalDialogTarget } from "./GoalDialog";

const STATE_TONE: Record<GoalState, ChipTone> = {
  open: "neutral",
  reached: "success",
  missed: "danger",
  changed: "warning",
};

const day = (at: number) => new Date(at * 1000).toLocaleDateString();

function StateChip({ state }: { state: GoalState }) {
  // An open goal needs no label: it is simply the goal.
  if (state === "open") return null;
  return (
    <Chip data-testid="goal-state" tone={STATE_TONE[state]}>
      {GOAL_STATE_LABEL[state]}
    </Chip>
  );
}

/** Everything that happened to one goal, oldest first, behind a disclosure. */
function GoalHistory({ goal }: { goal: GoalView }) {
  if (goal.history.length < 2) return null;
  return (
    <details className="mt-1 text-xs" data-testid="goal-history">
      <summary className="cursor-pointer text-muted-foreground">
        History ({goal.history.length - 1}{" "}
        {goal.history.length === 2 ? "change" : "changes"})
      </summary>
      <ol className="mt-1 flex flex-col gap-1 border-l border-border pl-3">
        {goal.history.map((entry, index) => (
          // Steps are only ever added at the end, so a step's place in the list is its own.
          // biome-ignore lint/suspicious/noArrayIndexKey: an append-only list; two steps can share a second and a name
          <li className="break-words" key={index}>
            <span className="font-medium">
              {goalStepWord(entry.step)} on {day(entry.at)}
            </span>
            {entry.was ? (
              <>
                {". It was: "}
                <q>{entry.was.text}</q>
                {entry.was.how ? ` (how we'd know: ${entry.was.how})` : ""}
              </>
            ) : null}
            {entry.reason ? `. Why: ${entry.reason}` : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}

function ShorterGoal({
  goal,
  canEdit,
  onEdit,
}: {
  goal: GoalView;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <li className="min-w-0" data-testid="shorter-goal">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-xs font-semibold text-muted-foreground">
          {GOAL_LEVEL_LABEL[goal.level]}
        </span>
        <span className="min-w-0 break-words font-medium">{goal.text}</span>
        <StateChip state={goal.state} />
      </p>
      {goal.how ? (
        <p className="break-words text-xs text-muted-foreground">
          How we'll know: {goal.how}
        </p>
      ) : null}
      {goal.state !== "open" && goal.reason ? (
        <p className="break-words text-xs text-muted-foreground">
          Why: {goal.reason}
        </p>
      ) : null}
      <GoalHistory goal={goal} />
      {canEdit ? (
        <Button
          aria-label={`Update goal: ${goal.text}`}
          className="mt-1 h-auto p-0"
          onClick={onEdit}
          size="sm"
          type="button"
          variant="link"
        >
          Update
        </Button>
      ) : null}
    </li>
  );
}

export function ProjectGoalCard({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const { record, failed, retry } = useProjectRecord(launch.record);
  const save = useSaveGoal(launch.record);
  const [target, setTarget] = useState<GoalDialogTarget | null>(null);
  const open = (next: GoalDialogTarget) => {
    save.reset();
    setTarget(next);
  };
  const onSave = (goal: GoalInput) =>
    save.mutate(goal, { onSuccess: () => setTarget(null) });

  if (!record) {
    // Not read yet: the card holds its place and says so. Not readable: said, with a way to read again.
    if (!failed)
      return (
        <section
          aria-busy="true"
          aria-label="Goal"
          className="glass rounded-2xl border p-4"
          data-testid="project-goal"
        >
          <p className="text-sm text-muted-foreground">Reading the goal…</p>
        </section>
      );
    return (
      <section
        aria-label="Goal"
        className="glass rounded-2xl border p-4"
        data-testid="project-goal"
      >
        <p className="text-sm" data-testid="goal-read-failed" role="alert">
          Couldn't read this project's goal.{" "}
          <Button onClick={retry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      </section>
    );
  }

  const { primary, shorter, earlier } = record.goals;
  const dialog = target ? (
    <GoalDialog
      failed={save.isError}
      isSaving={save.isPending}
      onClose={() => setTarget(null)}
      onSave={onSave}
      target={target}
    />
  ) : null;

  if (!primary) {
    // A cut read cannot tell "no goal" from "a goal set long ago": it says which it is.
    if (!record.facts.noGoal)
      return (
        <section
          aria-label="Goal"
          className="glass rounded-2xl border p-4"
          data-testid="project-goal"
        >
          <p className="text-sm" data-testid="goal-unknown">
            This project has more records than could be read here, so its goal
            can't be shown.{" "}
            <Button onClick={retry} size="sm" type="button" variant="outline">
              Try again
            </Button>
          </p>
        </section>
      );
    return (
      <section
        aria-label="Goal"
        className="glass rounded-2xl border p-4"
        data-testid="project-goal"
      >
        {isFounder ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-sm" data-testid="goal-missing">
              Your project has no goal yet. Say what you are aiming for and how
              everyone will know you got there.
            </p>
            <Button
              data-testid="goal-set"
              onClick={() => open({ kind: "new-primary" })}
              size="sm"
              type="button"
            >
              Set your goal
            </Button>
          </div>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="goal-missing"
          >
            This project has not set a goal yet.
          </p>
        )}
        {dialog}
      </section>
    );
  }

  return (
    <section
      aria-label="Goal"
      className="glass rounded-2xl border p-4"
      data-testid="project-goal"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold text-muted-foreground">Goal</h2>
        <StateChip state={primary.state} />
      </div>
      <p className="mt-1 break-words text-lg font-bold" data-testid="goal-text">
        {primary.text}
      </p>
      {primary.how ? (
        <p className="mt-1 break-words text-sm" data-testid="goal-how">
          <span className="font-semibold">How we'll know:</span> {primary.how}
        </p>
      ) : null}
      {primary.state !== "open" && primary.reason ? (
        <p className="mt-1 break-words text-sm" data-testid="goal-reason">
          <span className="font-semibold">Why:</span> {primary.reason}
        </p>
      ) : null}
      <GoalHistory goal={primary} />

      {shorter.length > 0 ? (
        <ul
          aria-label="Shorter goals"
          className="mt-3 flex flex-col gap-2 border-t border-border pt-3"
        >
          {shorter.map((goal) => (
            <ShorterGoal
              canEdit={isFounder}
              goal={goal}
              key={goal.id}
              onEdit={() => open({ kind: "existing", goal })}
            />
          ))}
        </ul>
      ) : null}

      {isFounder ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            data-testid="goal-update"
            onClick={() => open({ kind: "existing", goal: primary })}
            size="sm"
            type="button"
            variant="outline"
          >
            Update this goal
          </Button>
          <Button
            data-testid="goal-add-shorter"
            onClick={() => open({ kind: "new-shorter", under: primary.id })}
            size="sm"
            type="button"
            variant="outline"
          >
            Add a shorter goal
          </Button>
          {primary.state !== "open" ? (
            <Button
              data-testid="goal-set"
              onClick={() => open({ kind: "new-primary" })}
              size="sm"
              type="button"
            >
              Set a new goal
            </Button>
          ) : null}
        </div>
      ) : null}

      {earlier.length > 0 ? (
        <details className="mt-3 text-sm" data-testid="earlier-goals">
          <summary className="cursor-pointer text-muted-foreground">
            Earlier goals ({earlier.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {earlier.map((goal) => (
              <ShorterGoal
                canEdit={isFounder}
                goal={goal}
                key={goal.id}
                onEdit={() => open({ kind: "existing", goal })}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {!record.facts.noGoal ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="goals-cut"
        >
          This project has more records than could be read here. Older goals,
          and older steps in the history of the goals shown, may be missing.
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
