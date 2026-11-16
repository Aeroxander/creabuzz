/**
 * "What did you get done?": the one box a founder with nobody else on the project writes a piece of work in. One line
 * (and a link if they have one), one press: the task is made, the line is handed in, and the founder checks it
 * (`useSoloWin`). It says so in one sentence, and "How work counts" says how this is told apart from work someone else
 * checked.
 *
 * `plan` is "Add something to do": the task alone, with the finish line left to a closed disclosure. `finish` is for a
 * task the founder already has. A try that stopped part of the way says "Saved part of this. Try again." with a button
 * that carries on from the step that failed: a half-made task is never shown as done, and a retry makes no second one.
 */

import { useEffect, useId, useState } from "react";

import { MoreInfo } from "@/shared/ui/more-info";
import { Button } from "@/shared/ui/button";

import { checkRefusalOf, SOMEONE_ELSE_CHECKS } from "../lib/solo-refusal";
import { HOW_WORK_COUNTS, TASK_LIMITS, validLink } from "../lib/tasks";
import type { Launch } from "../models";
import { AGENT_NEEDS_PERSON } from "../use-account-agent";
import { useProjectTasks, type useSoloWin, useTaskActions } from "../use-tasks";
import { existingUserPubkey } from "@/shared/lib/identity";
import { MODAL_FOOTER_CLASS, Modal } from "./Modal";
import { FIELD_CLASS } from "./TaskParts";

/** What the box opens with. */
export interface SoloWinOpen {
  mode: "full" | "finish" | "plan";
  /** Words already typed, for the person to confirm or change. */
  text?: string;
  /** Plan mode: the "Done means" words that go with `text` (a starter task). */
  done?: string;
  /** Finish mode: the task the founder already has. */
  taskId?: string;
}

const SOLO_WORDS = {
  title: "What did you get done?",
  field: "What did you finish?",
  example: "Wrote the first page",
  link: "A link to show it (optional)",
  alone: "You are the only person here, so you check it yourself.",
  howCounts: "How work counts",
  done: "Done",
  cancel: "Cancel",
  close: "Close",
  saving: "Saving…",
  partSaved: "Saved part of this. Try again.",
  nothingSaved: "This was not saved. Try again.",
  tryAgain: "Try again",
  planTitle: "Add something to do",
  planField: "What do you want to do?",
  planExample: "Write the first page",
  planLine: "It goes on your list. You mark it done when it is.",
  add: "Add it",
  finishLooksLike: "What finished looks like",
  cantChange: "You can't change this after you add it",
  needWords: "Say what you finished, in a few words.",
  needPlan: "Say what you want to do, in a few words.",
  badLink: "A link starts with https://",
} as const;

const dayWords = (now: Date) =>
  now.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** What is said after "I did it" went through. */
export const doneLine = (now = new Date()) =>
  `Done on ${dayWords(now)}. Checked by you.`;

export function SoloWinDialog({
  launch,
  open,
  solo,
  onClose,
  onSaid,
}: {
  launch: Launch;
  open: SoloWinOpen;
  solo: ReturnType<typeof useSoloWin>;
  onClose: () => void;
  /** Said after the work is done or the task is added: the box has closed by then. */
  onSaid?: (text: string) => void;
}) {
  const me = existingUserPubkey();
  const id = useId();
  const plan = open.mode === "plan";
  const actions = useTaskActions(launch.record);
  const { tasks } = useProjectTasks(launch.record);
  const task =
    open.mode === "finish" && open.taskId
      ? (tasks?.find((t) => t.id === open.taskId) ?? null)
      : null;
  // A try that stopped on this task (or, for a new one, the newest): the words it had are the ones to carry on with.
  const pending =
    open.mode === "finish"
      ? solo.pending?.task?.id === open.taskId
        ? solo.pending
        : null
      : // Words handed in with the box (a promise line) start a new piece of work, never a retry of an older one.
        open.mode === "full" && open.text === undefined
        ? solo.pending
        : null;
  const [text, setText] = useState(
    open.text ??
      pending?.text ??
      (open.mode === "finish" ? (task?.what ?? "") : ""),
  );
  const [link, setLink] = useState(pending?.link ?? "");
  const [doneText, setDoneText] = useState(open.done ?? "");
  const [finishOpen, setFinishOpen] = useState(Boolean(open.done));
  const [problem, setProblem] = useState<string | null>(null);
  // A box opened fresh starts clean: what an earlier try said ("Saved part of this") is about that try, not this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the box opens
  useEffect(() => {
    if (!pending) solo.reset();
  }, []);
  const failed = solo.run.status === "failed" || (pending !== null && !plan);
  const running = solo.run.status === "running" || actions.make.isPending;
  // A check the server refused for good (someone else is on the project now, or this account is an agent): a second
  // try cannot change that, so it is said once and "Try again" is not offered.
  const refused =
    solo.run.status === "failed" ? checkRefusalOf(solo.run.error) : null;
  const said = (words: string) => {
    onClose();
    onSaid?.(words);
  };

  const submit = async () => {
    const words = text.trim();
    if (words === "") {
      setProblem(plan ? SOLO_WORDS.needPlan : SOLO_WORDS.needWords);
      return;
    }
    if (plan) {
      if (!me) return;
      try {
        await actions.make.mutateAsync({
          helper: me,
          what: words,
          done: doneText.trim() || words,
          size: "small",
          due: null,
        });
        said("Added. It is on your list.");
      } catch {
        // The failed state below says so, with Try again.
      }
      return;
    }
    if (open.mode === "finish" && !task && !pending) {
      // The task this box is for was not found: nothing is made, so no second task can appear.
      setProblem("That task could not be found. Close this and try again.");
      return;
    }
    const typedLink = link.trim();
    if (typedLink !== "" && !validLink(typedLink)) {
      setProblem(SOLO_WORDS.badLink);
      return;
    }
    setProblem(null);
    const result = pending
      ? await solo.retry()
      : await solo.start(
          task
            ? {
                start: "finish",
                text: words,
                link: typedLink || null,
                task: { id: task.id, helper: task.helper, madeBy: task.madeBy },
                seenEvidence: task.evidence.map((piece) => piece.id),
              }
            : { start: "full", text: words, link: typedLink || null },
        );
    if (result?.ok) said(doneLine());
  };

  return (
    <Modal
      describedBy={`${id}-line`}
      label={plan ? SOLO_WORDS.planTitle : SOLO_WORDS.title}
      labelledBy={`${id}-title`}
      onClose={() => {
        if (!running) onClose();
      }}
    >
      <form
        data-testid="solo-win-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) void submit();
        }}
      >
        <h2 className="text-lg font-bold" id={`${id}-title`}>
          {plan ? SOLO_WORDS.planTitle : SOLO_WORDS.title}
        </h2>
        <label
          className="mt-3 block text-sm font-medium"
          htmlFor={`${id}-what`}
        >
          {plan ? SOLO_WORDS.planField : SOLO_WORDS.field}
        </label>
        <textarea
          aria-describedby={problem ? `${id}-problem` : undefined}
          aria-invalid={
            problem && !problem.startsWith("A link") ? true : undefined
          }
          className={FIELD_CLASS}
          data-testid="solo-win-what"
          id={`${id}-what`}
          maxLength={TASK_LIMITS.what}
          onChange={(event) => setText(event.target.value)}
          placeholder={plan ? SOLO_WORDS.planExample : SOLO_WORDS.example}
          readOnly={running || pending !== null}
          aria-required="true"
          rows={2}
          value={text}
        />
        {plan ? (
          <div className="mt-2">
            <button
              aria-controls={`${id}-finish`}
              aria-expanded={finishOpen}
              className="text-sm text-primary-ink underline-offset-4 hover:underline max-sm:min-h-11"
              data-testid="solo-win-finish-toggle"
              onClick={() => setFinishOpen((was) => !was)}
              type="button"
            >
              {SOLO_WORDS.finishLooksLike}
            </button>
            <div hidden={!finishOpen} id={`${id}-finish`}>
              <label
                className="mt-1 block text-sm font-medium"
                htmlFor={`${id}-done`}
              >
                Done means
              </label>
              <textarea
                className={FIELD_CLASS}
                data-testid="solo-win-done-means"
                id={`${id}-done`}
                maxLength={TASK_LIMITS.done}
                onChange={(event) => setDoneText(event.target.value)}
                rows={2}
                value={doneText}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {SOLO_WORDS.cantChange}
              </p>
            </div>
          </div>
        ) : (
          <>
            <label
              className="mt-3 block text-sm font-medium"
              htmlFor={`${id}-link`}
            >
              {SOLO_WORDS.link}
            </label>
            <input
              aria-describedby={
                problem?.startsWith("A link") ? `${id}-problem` : undefined
              }
              aria-invalid={problem?.startsWith("A link") ? true : undefined}
              autoComplete="off"
              className={FIELD_CLASS}
              data-testid="solo-win-link"
              id={`${id}-link`}
              inputMode="url"
              maxLength={TASK_LIMITS.link}
              onChange={(event) => setLink(event.target.value)}
              readOnly={running}
              type="text"
              value={link}
            />
          </>
        )}
        <p className="mt-3 text-sm" id={`${id}-line`}>
          {plan ? SOLO_WORDS.planLine : SOLO_WORDS.alone}
        </p>
        {plan ? null : (
          <div className="mt-1">
            <MoreInfo label={SOLO_WORDS.howCounts} testId="solo-win-how-counts">
              {HOW_WORK_COUNTS}
            </MoreInfo>
          </div>
        )}
        {problem ? (
          <p className="mt-2 text-sm" id={`${id}-problem`} role="alert">
            {problem}
          </p>
        ) : null}
        {failed || (plan && actions.make.isError) ? (
          <p
            className="mt-2 text-sm"
            data-testid="solo-win-failed"
            role="alert"
          >
            {refused === "own-work"
              ? SOMEONE_ELSE_CHECKS
              : refused === "agent"
                ? AGENT_NEEDS_PERSON
                : plan
                  ? "The task was not added. Try again."
                  : solo.run.status === "failed" &&
                      solo.run.reached === "nothing"
                    ? SOLO_WORDS.nothingSaved
                    : SOLO_WORDS.partSaved}
          </p>
        ) : null}
        <div
          className={`mt-4 flex flex-wrap justify-end gap-2 ${MODAL_FOOTER_CLASS}`}
        >
          <Button
            data-testid="solo-win-cancel"
            disabled={running}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {refused ? SOLO_WORDS.close : SOLO_WORDS.cancel}
          </Button>
          {refused ? null : (
            <Button
              data-testid="solo-win-submit"
              disabled={running}
              type="submit"
            >
              {running
                ? SOLO_WORDS.saving
                : failed || (plan && actions.make.isError)
                  ? SOLO_WORDS.tryAgain
                  : plan
                    ? SOLO_WORDS.add
                    : SOLO_WORDS.done}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
