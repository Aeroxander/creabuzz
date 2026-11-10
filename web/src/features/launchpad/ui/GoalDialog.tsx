/**
 * The founder sets a goal, or says how one stands: open, reached, missed or changed.
 *
 * Saving publishes the goal as it now stands. What it was before is kept as its history; nothing here removes a goal.
 * Marking it missed or changed, or changing its words, asks for one line of why. A save that fails keeps what was
 * written and offers to try again.
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import {
  GOAL_LEVEL_LABEL,
  GOAL_LIMITS,
  GOAL_STATE_LABEL,
  GOAL_STATES,
  type GoalInput,
  type GoalLevel,
  type GoalState,
  type GoalView,
  goalIssue,
  newGoalId,
} from "../lib/goals";
import { Modal } from "./Modal";

const AREA_CLASS =
  "mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white";

const SHORTER: readonly GoalLevel[] = ["quarter", "month", "week"];

/** What the dialog is for: a new main goal, a new shorter goal under `under`, or a goal that exists. */
export type GoalDialogTarget =
  | { kind: "new-primary" }
  | { kind: "new-shorter"; under: string }
  | { kind: "existing"; goal: GoalView };

export function GoalDialog({
  target,
  isSaving,
  failed,
  onClose,
  onSave,
}: {
  target: GoalDialogTarget;
  isSaving: boolean;
  /** The last save did not go through. */
  failed: boolean;
  onClose: () => void;
  onSave: (goal: GoalInput) => void;
}) {
  const existing = target.kind === "existing" ? target.goal : null;
  const [level, setLevel] = useState<GoalLevel>(
    existing?.level ?? (target.kind === "new-shorter" ? "month" : "primary"),
  );
  const [text, setText] = useState(existing?.text ?? "");
  const [how, setHow] = useState(existing?.how ?? "");
  const [state, setState] = useState<GoalState>(existing?.state ?? "open");
  const [reason, setReason] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  // One id for the whole visit to the dialog: a retried save is the same goal, not a second one.
  const [id] = useState(() => existing?.id ?? newGoalId());
  const headingId = useId();

  const reworded =
    existing !== null &&
    (text.trim() !== existing.text || how.trim() !== existing.how);
  const needsReason = state === "missed" || state === "changed" || reworded;
  const title = existing
    ? "Update this goal"
    : target.kind === "new-shorter"
      ? "Add a shorter goal"
      : "Set your goal";

  const save = () => {
    const goal: GoalInput = {
      id,
      level,
      text,
      how,
      state,
      reason: needsReason ? reason : "",
      ...(target.kind === "new-shorter" ? { under: target.under } : {}),
    };
    const problem = goalIssue(goal, existing);
    setIssue(problem);
    if (!problem) onSave(goal);
  };

  return (
    <Modal label={title} labelledBy={headingId} onClose={onClose}>
      <h2 className="text-lg font-semibold" id={headingId}>
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {existing
          ? "Everyone can see how a goal stands and what it was before. Nothing is removed."
          : "Everyone can see it. You can change it later, and what it was stays on the record."}
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {target.kind === "new-shorter" ? (
          <fieldset className="m-0 min-w-0 p-0">
            <legend className="text-sm font-medium">For when?</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {SHORTER.map((choice) => (
                <label
                  className="flex items-center gap-1.5 text-sm"
                  key={choice}
                >
                  <input
                    checked={level === choice}
                    name="goal-level"
                    onChange={() => setLevel(choice)}
                    type="radio"
                    value={choice}
                  />
                  {GOAL_LEVEL_LABEL[choice]}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div>
          <label className="text-sm font-medium" htmlFor="goal-text">
            The goal
          </label>
          <textarea
            className={AREA_CLASS}
            id="goal-text"
            maxLength={GOAL_LIMITS.text}
            onChange={(e) => setText(e.target.value)}
            placeholder="A first version that ten people use."
            rows={2}
            value={text}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="goal-how">
            How we'll know
          </label>
          <textarea
            className={AREA_CLASS}
            id="goal-how"
            maxLength={GOAL_LIMITS.how}
            onChange={(e) => setHow(e.target.value)}
            placeholder="Ten people sign in during the same week."
            rows={2}
            value={how}
          />
        </div>
        {existing ? (
          <fieldset className="m-0 min-w-0 p-0">
            <legend className="text-sm font-medium">How does it stand?</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {GOAL_STATES.map((choice) => (
                <label
                  className="flex items-center gap-1.5 text-sm"
                  key={choice}
                >
                  <input
                    checked={state === choice}
                    name="goal-state"
                    onChange={() => setState(choice)}
                    type="radio"
                    value={choice}
                  />
                  {GOAL_STATE_LABEL[choice]}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {needsReason ? (
          <div>
            <label className="text-sm font-medium" htmlFor="goal-reason">
              {state === "missed" ? "Why was it missed?" : "Why did it change?"}
            </label>
            <textarea
              aria-describedby="goal-reason-hint"
              className={AREA_CLASS}
              id="goal-reason"
              maxLength={GOAL_LIMITS.reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              value={reason}
            />
            <p className="text-xs text-muted-foreground" id="goal-reason-hint">
              One line. It shows on the project's record.
            </p>
          </div>
        ) : null}
        {issue ? (
          <p
            className="text-sm text-red-700 dark:text-red-300"
            data-testid="goal-issue"
            role="alert"
          >
            {issue}
          </p>
        ) : null}
        {failed && !isSaving ? (
          <p
            className="text-sm text-red-700 dark:text-red-300"
            data-testid="goal-save-failed"
            role="alert"
          >
            Your goal was not saved. What you wrote is still here.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={isSaving} onClick={save} type="button">
            {isSaving ? "Saving…" : failed ? "Try again" : "Save goal"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
