/**
 * The blocks of the weekly update dialog that have their own state or their own rules, kept out of
 * `PostUpdateDialog.tsx` so it stays one readable form: last week's promises to answer, the finished work offered as
 * lines, and "Ask for help". They only show and collect; what is published is decided in the dialog.
 */

import type { Dispatch, RefObject, SetStateAction } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  MARK_LABEL,
  MARK_STATES,
  type MarkState,
  PROMISE_LIMITS,
  type PromiseEntry,
} from "../lib/promises";
import {
  HELP_SIZE_LABEL,
  HELP_SIZES,
  type HelpSize,
  PART_HEADINGS,
  UPDATE_LIMITS,
  type WorkLine,
} from "../lib/weekly-update";

export const AREA_CLASS =
  "mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white";

export type Marks = Record<string, { state: MarkState; note: string }>;

/**
 * "What you said last time": one row per promise still to answer, with Done, Not done and Changed and an optional short
 * note. Answering is never forced: "Not answering yet" is where each starts, and the way to take a tapped answer back
 * before publishing. `firstAnswer` is the first answer, which the dialog focuses in week two.
 */
export function PromiseAnswers({
  due,
  marks,
  setMarks,
  firstAnswer,
}: {
  due: readonly PromiseEntry[];
  marks: Marks;
  setMarks: Dispatch<SetStateAction<Marks>>;
  firstAnswer: RefObject<HTMLInputElement | null>;
}) {
  return (
    <section
      aria-labelledby="update-due-heading"
      className="rounded-xl border border-border p-3"
      data-testid="update-due"
    >
      <h3 className="text-sm font-medium" id="update-due-heading">
        What you said last time
      </h3>
      <p className="text-xs text-muted-foreground">
        Say what came of each. Everyone can read your answers, and an answer
        can't be changed after you publish. If you are not sure yet, leave it
        for a later update.
      </p>
      <div className="mt-2 flex flex-col gap-3">
        {due.map((promise, index) => {
          const mark = marks[promise.id];
          const name = `promise-${promise.id}`;
          return (
            <fieldset
              className="m-0 min-w-0 p-0"
              data-testid="update-due-promise"
              key={promise.id}
            >
              <legend className="break-words text-sm">{promise.text}</legend>
              <div className="mt-1 grid grid-cols-2 gap-x-3 sm:flex sm:flex-wrap">
                {MARK_STATES.map((state, at) => (
                  <label
                    className="flex items-center gap-1.5 text-sm max-sm:min-h-11"
                    key={state}
                  >
                    <input
                      checked={mark?.state === state}
                      name={name}
                      onChange={() =>
                        setMarks((was) => ({
                          ...was,
                          [promise.id]: {
                            state,
                            note: was[promise.id]?.note ?? "",
                          },
                        }))
                      }
                      ref={index === 0 && at === 0 ? firstAnswer : undefined}
                      type="radio"
                      value={state}
                    />
                    {MARK_LABEL[state]}
                  </label>
                ))}
                {/* The way back: a tapped answer can be taken off again before publishing. */}
                <label className="flex items-center gap-1.5 text-sm text-muted-foreground max-sm:min-h-11">
                  <input
                    checked={!mark}
                    name={name}
                    onChange={() =>
                      setMarks((was) => {
                        const { [promise.id]: _, ...rest } = was;
                        return rest;
                      })
                    }
                    type="radio"
                    value=""
                  />
                  Not answering yet
                </label>
              </div>
              {mark ? (
                <Input
                  aria-label={`Short note for: ${promise.text}`}
                  className="mt-1"
                  maxLength={PROMISE_LIMITS.note}
                  onChange={(e) =>
                    setMarks((was) => ({
                      ...was,
                      [promise.id]: { ...mark, note: e.target.value },
                    }))
                  }
                  placeholder="Short note (optional)"
                  value={mark.note}
                />
              ) : null}
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The work finished since the last update, as the lines "What happened this week" starts with. Each line says who
 * checked it ("Work accepted" for work someone else accepted, "Done, checked by you" for work only the founder checked)
 * and can be left out. The two kinds are never worded alike.
 */
export function WorkLines({
  offered,
  covered,
  onUncover,
  onLeaveOut,
}: {
  offered: readonly WorkLine[];
  /** A draft already says the work someone else accepted, so those lines are not added again. */
  covered: boolean;
  onUncover: () => void;
  onLeaveOut: (id: string) => void;
}) {
  return (
    <section
      aria-labelledby="update-accepted-heading"
      className="rounded-xl border border-border p-3"
      data-testid="update-accepted"
    >
      <h3 className="text-sm font-medium" id="update-accepted-heading">
        Work finished since your last update
      </h3>
      {covered ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="update-accepted-covered"
        >
          The draft already says the accepted work, so those lines are not added
          again.{" "}
          <Button
            className="h-auto p-0 text-xs"
            onClick={onUncover}
            size="sm"
            type="button"
            variant="link"
          >
            Add these lines too
          </Button>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          These go in as the first lines of what happened. Take off any you'd
          rather not mention.
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {offered.map((task) => (
          <li
            className="flex items-start gap-2 text-sm"
            data-testid="update-accepted-item"
            key={task.id}
          >
            <span className="min-w-0 flex-1 break-words">
              <span className="text-muted-foreground">
                {task.kind === "founder"
                  ? "Done, checked by you: "
                  : "Work accepted: "}
              </span>
              {task.what}
            </span>
            <Button
              aria-label={`Leave out: ${task.what}`}
              className="max-sm:h-11"
              onClick={() => onLeaveOut(task.id)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Leave out
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Ask for help": the help box, how big it is and a rough time. People answer with "I can help". */
export function HelpBlock({
  help,
  setHelp,
  size,
  setSize,
  time,
  setTime,
  box,
}: {
  help: string;
  setHelp: (value: string) => void;
  size: HelpSize;
  setSize: (value: HelpSize) => void;
  time: string;
  setTime: (value: string) => void;
  box: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div
      className="rounded-xl border border-border p-3"
      data-testid="update-help-block"
    >
      <label className="text-sm font-medium" htmlFor="update-help">
        {PART_HEADINGS.help} (optional)
      </label>
      <p className="text-xs text-muted-foreground" id="update-help-hint">
        Say what you need. People can answer with "I can help", and you see who
        offered.
      </p>
      <textarea
        aria-describedby="update-help-hint"
        id="update-help"
        className={AREA_CLASS}
        maxLength={UPDATE_LIMITS.help}
        onChange={(e) => setHelp(e.target.value)}
        ref={box}
        placeholder="For example: someone to test sign-up on an older phone."
        rows={2}
        value={help}
      />
      {help.trim() !== "" ? (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <fieldset className="m-0 min-w-0 p-0">
            <legend className="text-sm font-medium">How big is it?</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {HELP_SIZES.map((option) => (
                <label
                  className="flex items-center gap-1.5 text-sm max-sm:min-h-11"
                  key={option}
                >
                  <input
                    checked={size === option}
                    name="update-help-size"
                    onChange={() => setSize(option)}
                    type="radio"
                    value={option}
                  />
                  {HELP_SIZE_LABEL[option]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="min-w-0 flex-1">
            <label className="text-sm font-medium" htmlFor="update-help-time">
              Rough time (optional)
            </label>
            <Input
              id="update-help-time"
              className="mt-1"
              maxLength={UPDATE_LIMITS.helpTime}
              onChange={(e) => setTime(e.target.value)}
              placeholder="about 3 days"
              value={time}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
