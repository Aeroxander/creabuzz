/**
 * The form a task is made in: what the task is, what "done" means (required: it is what the work is checked
 * against), a size, and a due date when there is one. A task made from an offer keeps the request's words and size.
 *
 * What was typed stays until the task is made: a failed send leaves the form as it was, with "Try again".
 */

import { type ReactNode, useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import { REWARDS_LINE, TASK_LIMITS, taskProblem } from "../lib/tasks";
import {
  HELP_SIZE_LABEL,
  HELP_SIZES,
  type HelpSize,
} from "../lib/weekly-update";
import { FIELD_CLASS, SendFailed, todayDate } from "./TaskParts";

export interface TaskDraft {
  what: string;
  done: string;
  size: HelpSize;
  due: string | null;
}

export function TaskForm({
  testId,
  title,
  fixed,
  busy,
  failed,
  blocked,
  onSend,
  onCancel,
  children,
}: {
  testId: string;
  title: string;
  /** The request's own words and size, when the task comes from an offer: shown, not edited. */
  fixed?: { what: string; size: HelpSize };
  busy: boolean;
  failed: string | null;
  /** Why the task cannot be made yet (nobody picked), or null. */
  blocked?: string | null;
  onSend: (draft: TaskDraft) => void;
  onCancel: () => void;
  /** Fields above the form's own: who the task is for. */
  children?: ReactNode;
}) {
  const id = useId();
  const [what, setWhat] = useState(fixed?.what ?? "");
  const [done, setDone] = useState("");
  const [size, setSize] = useState<HelpSize>(fixed?.size ?? "small");
  const [due, setDue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (busy) return;
    if (blocked) return setProblem(blocked);
    const found = taskProblem({ what, done, due, today: todayDate() });
    if (found) return setProblem(found.message);
    setProblem(null);
    onSend({ what, done, size, due: due || null });
  };

  return (
    <form
      aria-label={title}
      className="mt-2 rounded-lg border border-border bg-background/70 p-2"
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy) return;
        e.stopPropagation();
        onCancel();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {children}
      {fixed ? (
        <p className="break-words text-sm" data-testid={`${testId}-what`}>
          <span className="font-semibold">The task:</span>{" "}
          <span className="whitespace-pre-wrap">{fixed.what}</span>{" "}
          <span className="text-xs text-muted-foreground">
            ({HELP_SIZE_LABEL[fixed.size]})
          </span>
        </p>
      ) : (
        <>
          <label className="text-sm font-medium" htmlFor={`${id}-what`}>
            What is the task
          </label>
          <textarea
            className={FIELD_CLASS}
            id={`${id}-what`}
            maxLength={TASK_LIMITS.what}
            onChange={(e) => setWhat(e.target.value)}
            rows={2}
            value={what}
          />
          <fieldset className="mt-2">
            <legend className="text-sm font-medium">Size</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {HELP_SIZES.map((option) => (
                <label className="flex items-center gap-1 text-sm" key={option}>
                  <input
                    checked={size === option}
                    name={`${id}-size`}
                    onChange={() => setSize(option)}
                    type="radio"
                  />
                  {HELP_SIZE_LABEL[option]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}
      <label className="mt-2 block text-sm font-medium" htmlFor={`${id}-done`}>
        Done means
      </label>
      <p className="text-xs text-muted-foreground" id={`${id}-done-hint`}>
        What finished looks like, so anyone can check it. It cannot be changed
        once the task is made.
      </p>
      <textarea
        aria-describedby={`${id}-done-hint`}
        aria-required="true"
        // biome-ignore lint/a11y/noAutofocus: the form opens because the person asked for it; when the words are fixed, this is the first thing to write
        autoFocus={Boolean(fixed)}
        className={FIELD_CLASS}
        id={`${id}-done`}
        maxLength={TASK_LIMITS.done}
        onChange={(e) => setDone(e.target.value)}
        placeholder="For example: sign-up works on an Android 9 phone, with a screen recording."
        rows={2}
        value={done}
      />
      <label className="mt-2 block text-sm font-medium" htmlFor={`${id}-due`}>
        Due date (optional)
      </label>
      <input
        className={FIELD_CLASS}
        id={`${id}-due`}
        min={todayDate()}
        onChange={(e) => setDue(e.target.value)}
        type="date"
        value={due}
      />
      <p
        className="mt-2 text-xs text-muted-foreground"
        data-testid="task-rewards-line"
      >
        {REWARDS_LINE} The task is public: anyone can read it.
      </p>
      {problem ? (
        <p
          className="mt-1 text-sm text-red-700 dark:text-red-300"
          data-testid={`${testId}-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button disabled={busy} size="sm" type="submit">
          {busy ? "Saving…" : "Make the task"}
        </Button>
        <Button
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
      {failed ? (
        <SendFailed onRetry={submit} testId={`${testId}-failed`}>
          {failed}
        </SendFailed>
      ) : null}
    </form>
  );
}
