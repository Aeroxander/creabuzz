/**
 * One task on a project's page: what it is, what "done" means, who it is with, how it stands and when it is due, the
 * work handed in so far, and the steps the person looking may take.
 *
 * The helper can say yes or no, hand work in, ask for more time, or give up. Someone else on the team can confirm a
 * piece of work, send it back with a reason, give more time, or cancel. The person who did the work is never offered
 * "Confirm": when they are also on the team the row says someone else has to, and when there is nobody else it says
 * that too.
 *
 * A check is of one piece of work: the box shows that piece, and if more work arrives while it is open it closes
 * and says so, so nobody confirms what they did not read.
 *
 * A task the helper has not said yes to is shown only to the team and to that person (the card leaves it out for
 * everyone else). The record itself is public; the form that makes a task says so.
 */

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import { agentLabel } from "../lib/agent-label";
import {
  confirmRule,
  dueLine,
  REWARDS_LINE,
  TASK_STATE_LABEL,
  type TaskEvidence,
  type TaskState,
  type TaskView,
} from "../lib/tasks";
import { withReason } from "../lib/removals";
import { HELP_SIZE_LABEL } from "../lib/weekly-update";
import type { Launch } from "../models";
import {
  EvidenceChangedError,
  EvidenceGoneError,
  type TaskSent,
  useTaskActions,
} from "../use-tasks";
import {
  dateWords,
  EvidencePiece,
  PersonLink,
  SendFailed,
  StepBox,
  todayDate,
} from "./TaskParts";

const TONE: Record<TaskState, ChipTone> = {
  offered: "neutral",
  "in-progress": "info",
  submitted: "warning",
  "sent-back": "warning",
  confirmed: "success",
  "given-up": "neutral",
  cancelled: "neutral",
};

type Box =
  | "hand-in"
  | "more-time"
  | "give-up"
  | "decline"
  | "cancel"
  | { grant: string }
  /** A check of one piece of work, and every piece that was on the page when the box opened. */
  | { check: "confirm" | "send-back"; piece: string; known: string[] };

const CHANGED =
  "More work was handed in on this task while you were reading, so nothing was sent. Read what is there now, then answer it.";

const ADOPTED =
  "An earlier try had already gone through, so nothing new was sent.";

/** A small labelled group with a question and two answers: confirm, and say no to a task. */
function AskBox({
  testId,
  title,
  children,
  yes,
  no,
  busy,
  busyWords,
  onYes,
  onNo,
  failed,
}: {
  testId: string;
  title: string;
  children: React.ReactNode;
  yes: string;
  no: string;
  busy: boolean;
  busyWords: string;
  onYes: () => void;
  onNo: () => void;
  failed: { words: string; testId: string } | null;
}) {
  const id = useId();
  const first = useRef<HTMLButtonElement | null>(null);
  // The box opens because the person asked for it: the keyboard starts on its first control.
  useEffect(() => first.current?.focus(), []);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the box; a labelled group says the same
    <div
      aria-labelledby={`${id}-title`}
      className="mt-2 rounded-lg border border-border bg-background/70 p-2"
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy) return;
        e.stopPropagation();
        onNo();
      }}
      role="group"
    >
      <p className="text-sm font-semibold" id={`${id}-title`}>
        {title}
      </p>
      {children}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={onYes}
          ref={first}
          size="sm"
          type="button"
        >
          {busy ? busyWords : yes}
        </Button>
        <Button
          disabled={busy}
          onClick={onNo}
          size="sm"
          type="button"
          variant="outline"
        >
          {no}
        </Button>
      </div>
      {failed ? (
        <SendFailed onRetry={onYes} testId={failed.testId}>
          {failed.words}
        </SendFailed>
      ) : null}
    </div>
  );
}

export function TaskRow({
  launch,
  task,
  team,
  viewer,
  names,
  onSaid,
}: {
  launch: Launch;
  task: TaskView;
  team: ReadonlySet<string>;
  viewer: string | null;
  names: (pubkey: string) => string;
  /** Says what just happened, in the card: the row itself may be gone from the list by then. */
  onSaid: (text: string) => void;
}) {
  const actions = useTaskActions(launch.record);
  const [box, setBox] = useState<Box | null>(null);
  const row = useRef<HTMLLIElement | null>(null);
  /** The control that opened the box: where the keyboard goes back to when the box closes. */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  const isHelper = viewer === task.helper;
  const onTeam = viewer !== null && team.has(viewer);
  /** The team's side of a task is someone on the team who is not doing it. */
  const checks = onTeam && !isHelper;
  const rule = confirmRule(task, team, viewer);
  const open = (next: Box, opener: string) => {
    for (const action of Object.values(actions)) action.reset();
    setReturnTo(null);
    setBox(next);
    opened.current = opener;
  };
  const opened = useRef<string | null>(null);
  const close = () => {
    setBox(null);
    setReturnTo(opened.current);
  };
  // After a box closes: back to the button that opened it, or to the row when that button is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: looked for again once the box is gone from the page
  useEffect(() => {
    if (returnTo === null || box !== null) return;
    const target = row.current?.querySelector<HTMLElement>(
      `[data-task-focus="${returnTo}"]`,
    );
    (target ?? row.current)?.focus();
    setReturnTo(null);
  }, [returnTo, box]);
  const done = (said: string) => (sent: TaskSent) => {
    setBox(null);
    onSaid(sent.adopted ? `${said} ${ADOPTED}` : said);
  };

  // A check is of the piece that was read. If more work is waiting now than when the box opened, the box closes.
  const waitingIds = task.waiting.map((piece) => piece.id).join(",");
  const check =
    typeof box === "object" && box !== null && "check" in box ? box : null;
  const checkStale =
    check !== null &&
    !actions.confirm.isPending &&
    !actions.sendBack.isPending &&
    (!task.waiting.some((piece) => piece.id === check.piece) ||
      task.evidence.some((piece) => !check.known.includes(piece.id)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the waiting pieces change under an open box
  useEffect(() => {
    if (!checkStale) return;
    setBox(null);
    onSaid(CHANGED);
  }, [checkStale, waitingIds]);

  const due = dueLine(task, dateWords);
  const pendingAsk = task.moreTime.find((ask) => !ask.granted) ?? null;
  const canWork = task.state === "in-progress" || task.state === "sent-back";
  const reference = { id: task.id, helper: task.helper, madeBy: task.madeBy };
  const several = task.waiting.length > 1;
  const pieceName = (piece: TaskEvidence) =>
    several ? ` (piece ${task.evidence.indexOf(piece) + 1})` : "";

  /** A check that could not be sent because the work is not as it was read: said in the card, and the box closes. */
  const notAsRead = (gone: string) => (error: unknown) => {
    if (error instanceof EvidenceGoneError) onSaid(gone);
    else if (error instanceof EvidenceChangedError) onSaid(CHANGED);
    else return;
    setBox(null);
  };
  const expected = (error: unknown) =>
    error instanceof EvidenceGoneError || error instanceof EvidenceChangedError;
  const confirm = (piece: TaskEvidence, seen: readonly string[]) =>
    actions.confirm.mutate(
      { task: reference, evidenceId: piece.id, seen },
      {
        onSuccess: done("You confirmed this work."),
        onError: notAsRead(
          "That work was removed before you confirmed it, so nothing was confirmed.",
        ),
      },
    );

  return (
    <li
      aria-label={`Task: ${task.what}`}
      className="rounded-xl border border-border bg-background/60 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-late={task.late ? "true" : undefined}
      data-state={task.state}
      data-testid="task"
      id={`task-${task.id}`}
      ref={row}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip data-testid="task-state" tone={TONE[task.state]}>
          {TASK_STATE_LABEL[task.state]}
        </Chip>
        {task.late ? (
          <Chip data-testid="task-late" tone="danger">
            Late
          </Chip>
        ) : null}
        <Chip>{HELP_SIZE_LABEL[task.size]}</Chip>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium">
        {task.what}
      </p>
      <p className="mt-1 break-words text-sm" data-testid="task-done-means">
        <span className="font-semibold">Done means:</span>{" "}
        <span className="whitespace-pre-wrap">{task.done}</span>
      </p>
      <p
        className="mt-1 break-words text-xs text-muted-foreground"
        data-testid="task-who"
      >
        {task.agreed === null ? "Given to" : "With"}{" "}
        <PersonLink name={names(task.helper)} pubkey={task.helper} />
        {task.agreed === null ? ", who has not said yes" : ""}
        {task.helperAgent ? (
          <>
            {" "}
            <Chip data-testid="task-helper-agent" tone="info">
              {agentLabel(
                task.helperAgent.owner ? names(task.helperAgent.owner) : null,
              )}
            </Chip>
          </>
        ) : null}
        {" · "}made by {names(task.madeBy)}
        {due ? (
          <>
            {" · "}
            <span data-testid="task-due">{due}</span>
          </>
        ) : null}
      </p>
      {task.agreed === null && onTeam && !isHelper ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="task-not-agreed"
        >
          Only the team and {names(task.helper)} see this task on this page
          until they say yes. The task itself is a public record that names
          them.
        </p>
      ) : null}

      {task.evidence.length > 0 ? (
        <div className="mt-2 space-y-2">
          {task.evidence.map((piece, i) => (
            <EvidencePiece
              heading={
                task.evidence.length > 1
                  ? `Work handed in (piece ${i + 1} of ${task.evidence.length})`
                  : "Work handed in"
              }
              key={piece.id}
              names={names}
              piece={piece}
            />
          ))}
        </div>
      ) : null}
      {task.orphanSendBacks.map((back) => (
        <p
          className="mt-2 break-words text-sm"
          data-testid="task-orphan-send-back"
          key={back.id}
        >
          <span className="text-xs text-muted-foreground">
            Sent back by {names(back.by)}. The work it was about has since been
            removed:
          </span>{" "}
          {back.note}
        </p>
      ))}
      {task.stepRemoved ? (
        <p className="mt-2 text-sm" data-testid="task-step-removed">
          The team recorded steps on this task, but no step signed by{" "}
          {names(task.helper)} is on the server. A step was removed, or the
          team's steps answer nothing.
        </p>
      ) : null}
      {task.confirmedWithoutEvidence ? (
        <p className="mt-2 text-sm" data-testid="task-evidence-missing">
          A team member confirmed work on this task, but the work it names is
          not on the server (it may have been removed), so it is not counted as
          accepted.
        </p>
      ) : null}
      {task.ignoredConfirmation ? (
        <p className="mt-2 text-sm" data-testid="task-confirm-ignored">
          A confirmation was signed by someone who may not confirm this work
          (the person who did it, whoever runs them, or an agent). It is not
          counted.
        </p>
      ) : null}
      {task.moreTime.map((ask) => (
        <div
          className="mt-2 break-words text-sm"
          data-testid="task-more-time"
          key={ask.id}
        >
          <span className="text-xs text-muted-foreground">
            {names(task.helper)} asked for more time
            {ask.wanted ? `, until ${dateWords(ask.wanted)}` : ""}:
          </span>{" "}
          {ask.reason}
          {ask.granted ? (
            <span className="block text-xs text-muted-foreground">
              {names(ask.granted.by)} gave until {dateWords(ask.granted.due)}.
            </span>
          ) : checks && canWork ? (
            typeof box === "object" &&
            box !== null &&
            "grant" in box &&
            box.grant === ask.id ? (
              <StepBox
                busy={actions.grant.isPending}
                date={{
                  label: "New date",
                  min: todayDate(),
                  initial:
                    ask.wanted && ask.wanted >= todayDate() ? ask.wanted : "",
                  required: "Pick the new date.",
                }}
                failed={
                  actions.grant.isError
                    ? withReason(
                        "More time was not given.",
                        actions.grant.error,
                      )
                    : null
                }
                note={{ label: "A few words (optional)" }}
                onCancel={close}
                onSend={(draft) =>
                  actions.grant.mutate(
                    { task: reference, askId: ask.id, due: draft.date },
                    { onSuccess: done("More time given.") },
                  )
                }
                send="Give more time"
                sending="Saving…"
                testId="task-grant-box"
                title="Give more time"
              />
            ) : (
              <Button
                className="ml-2"
                data-task-focus={`grant-${ask.id}`}
                onClick={() => open({ grant: ask.id }, `grant-${ask.id}`)}
                size="sm"
                type="button"
                variant="outline"
              >
                Give more time
              </Button>
            )
          ) : null}
        </div>
      ))}

      {/* The helper's steps. */}
      {isHelper && task.state === "offered" ? (
        box === "decline" ? (
          <AskBox
            busy={actions.giveUp.isPending}
            busyWords="Saving…"
            failed={
              actions.giveUp.isError
                ? {
                    words: withReason(
                      "Your no was not saved.",
                      actions.giveUp.error,
                    ),
                    testId: "task-decline-failed",
                  }
                : null
            }
            no="Keep it open"
            onNo={close}
            onYes={() =>
              actions.giveUp.mutate(
                { task: reference, note: "" },
                { onSuccess: done("You said no to this task.") },
              )
            }
            testId="task-decline-box"
            title="Say no to this task?"
            yes="Yes, say no"
          >
            <p className="mt-1 text-sm">
              The task closes for you. You never took it on, so saying no leaves
              no mark on your record.
            </p>
          </AskBox>
        ) : (
          <div className="mt-2" data-testid="task-answer">
            <p className="text-sm">
              {names(task.madeBy)} gave you this task. It is yours only if you
              say yes, and saying no leaves no mark on your record.
            </p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="task-rewards-line"
            >
              {REWARDS_LINE}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={actions.accept.isPending}
                onClick={() =>
                  actions.accept.mutate(reference, {
                    onSuccess: done("You said yes. The task is yours."),
                  })
                }
                size="sm"
                type="button"
              >
                {actions.accept.isPending ? "Saving…" : "Yes, I'll do it"}
              </Button>
              <Button
                data-task-focus="decline"
                disabled={actions.accept.isPending}
                onClick={() => open("decline", "decline")}
                size="sm"
                type="button"
                variant="outline"
              >
                No, not for me
              </Button>
            </div>
            {actions.accept.isError ? (
              <SendFailed
                onRetry={() =>
                  actions.accept.mutate(reference, {
                    onSuccess: done("You said yes. The task is yours."),
                  })
                }
                testId="task-accept-failed"
              >
                {withReason("Your yes was not saved.", actions.accept.error)}
              </SendFailed>
            ) : null}
          </div>
        )
      ) : null}
      {isHelper && !onTeam && task.state === "submitted" ? (
        <p className="mt-2 text-sm" data-testid="task-waiting-check">
          Your work is handed in. Someone else on the team checks it against
          “Done means”.
        </p>
      ) : null}
      {isHelper && (canWork || task.state === "submitted") ? (
        box === "hand-in" ? (
          <StepBox
            busy={actions.evidence.isPending}
            evidence
            failed={
              actions.evidence.isError
                ? withReason(
                    "Your work was not handed in.",
                    actions.evidence.error,
                  )
                : null
            }
            hint="What you hand in is public: anyone can read it."
            note={{
              label: "What you did",
              placeholder: "What was done, and where to look.",
            }}
            onCancel={close}
            onSend={(draft) =>
              actions.evidence.mutate(
                {
                  task: reference,
                  note: draft.note,
                  links: draft.links,
                  files: draft.files,
                },
                {
                  onSuccess: done("Your work is handed in. The team is told."),
                },
              )
            }
            send="Hand in"
            sending="Handing in…"
            testId="task-hand-in-box"
            title="Hand in work"
          />
        ) : box === "more-time" ? (
          <StepBox
            busy={actions.moreTime.isPending}
            date={{ label: "Until (optional)", min: todayDate() }}
            failed={
              actions.moreTime.isError
                ? withReason("Your ask was not sent.", actions.moreTime.error)
                : null
            }
            note={{
              label: "Why you need more time",
              required: "Say why, so the team can decide.",
            }}
            onCancel={close}
            onSend={(draft) =>
              actions.moreTime.mutate(
                { task: reference, note: draft.note, due: draft.date || null },
                { onSuccess: done("You asked for more time.") },
              )
            }
            send="Ask for more time"
            sending="Sending…"
            testId="task-more-time-box"
            title="Ask for more time"
          />
        ) : box === "give-up" ? (
          <StepBox
            busy={actions.giveUp.isPending}
            failed={
              actions.giveUp.isError
                ? withReason("This was not saved.", actions.giveUp.error)
                : null
            }
            hint="Giving up closes the task for you. It stays on the project's record and on yours, whatever happens after."
            note={{ label: "A few words (optional)" }}
            onCancel={close}
            onSend={(draft) =>
              actions.giveUp.mutate(
                { task: reference, note: draft.note },
                { onSuccess: done("You gave up this task.") },
              )
            }
            send="Give up the task"
            sending="Saving…"
            testId="task-give-up-box"
            title="Give up the task"
          />
        ) : box === null ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              data-task-focus="hand-in"
              onClick={() => open("hand-in", "hand-in")}
              size="sm"
              type="button"
            >
              {task.evidence.length > 0 ? "Hand in again" : "Hand in work"}
            </Button>
            {canWork && !pendingAsk ? (
              <Button
                data-task-focus="more-time"
                onClick={() => open("more-time", "more-time")}
                size="sm"
                type="button"
                variant="outline"
              >
                Ask for more time
              </Button>
            ) : null}
            <Button
              data-task-focus="give-up"
              onClick={() => open("give-up", "give-up")}
              size="sm"
              type="button"
              variant="outline"
            >
              Give up
            </Button>
          </div>
        ) : null
      ) : null}

      {/* Checking: only someone on the team who did not do the work, and one piece at a time. */}
      {task.state === "submitted" && task.waiting.length > 0 && onTeam ? (
        rule.may ? (
          check ? (
            (() => {
              const piece = task.waiting.find((p) => p.id === check.piece);
              if (!piece) return null;
              return check.check === "confirm" ? (
                <AskBox
                  busy={actions.confirm.isPending}
                  busyWords="Saving…"
                  failed={
                    actions.confirm.isError && !expected(actions.confirm.error)
                      ? {
                          words: withReason(
                            "The work was not confirmed.",
                            actions.confirm.error,
                          ),
                          testId: "task-confirm-failed",
                        }
                      : null
                  }
                  no="Not yet"
                  onNo={close}
                  onYes={() => confirm(piece, check.known)}
                  testId="task-confirm-box"
                  title={`Confirm this work${pieceName(piece)}?`}
                  yes="Yes, confirm"
                >
                  <p className="mt-1 text-sm">
                    You are confirming this piece, and only this piece, against
                    “Done means”. It then shows as work accepted on the
                    project's record and on {names(task.helper)}'s.
                  </p>
                  <div className="mt-2" data-testid="task-confirm-piece">
                    <EvidencePiece
                      heading="The work you are confirming"
                      names={names}
                      piece={piece}
                    />
                  </div>
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    data-testid="task-rewards-line"
                  >
                    {REWARDS_LINE}
                  </p>
                </AskBox>
              ) : (
                <StepBox
                  busy={actions.sendBack.isPending}
                  failed={
                    actions.sendBack.isError &&
                    !expected(actions.sendBack.error)
                      ? withReason(
                          "The work was not sent back.",
                          actions.sendBack.error,
                        )
                      : null
                  }
                  hint="Your reason is public: anyone can read it."
                  note={{
                    label: "What is missing",
                    placeholder:
                      "What still has to happen for this to be done.",
                    required:
                      "Say what is missing, so the work can be finished.",
                  }}
                  onCancel={close}
                  onSend={(draft) =>
                    actions.sendBack.mutate(
                      {
                        task: reference,
                        evidenceId: piece.id,
                        seen: check.known,
                        note: draft.note,
                      },
                      {
                        onSuccess: done("You sent this work back."),
                        onError: notAsRead(
                          "That work was removed before you answered it, so nothing was sent.",
                        ),
                      },
                    )
                  }
                  send="Send back"
                  sending="Sending…"
                  testId="task-send-back-box"
                  title={`Send the work back${pieceName(piece)}`}
                />
              );
            })()
          ) : box === null ? (
            <ul className="mt-2 flex flex-col gap-2" data-testid="task-checks">
              {task.waiting.map((piece) => {
                const known = task.evidence.map((p) => p.id);
                return (
                  <li className="flex flex-wrap gap-2" key={piece.id}>
                    <Button
                      aria-label={`Confirm it's done${pieceName(piece)}`}
                      data-task-focus={`confirm-${piece.id}`}
                      onClick={() =>
                        open(
                          { check: "confirm", piece: piece.id, known },
                          `confirm-${piece.id}`,
                        )
                      }
                      size="sm"
                      type="button"
                    >
                      Confirm it's done{pieceName(piece)}
                    </Button>
                    <Button
                      aria-label={`Send back${pieceName(piece)}`}
                      data-task-focus={`send-back-${piece.id}`}
                      onClick={() =>
                        open(
                          { check: "send-back", piece: piece.id, known },
                          `send-back-${piece.id}`,
                        )
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Send back{pieceName(piece)}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null
        ) : (
          <p className="mt-2 text-sm" data-testid="task-cannot-confirm">
            {rule.why === "runs-helper"
              ? "You run the agent that did this work, so someone else on the team has to confirm it."
              : "You did this work, so someone else on the team has to confirm it."}
            {rule.someoneCan
              ? null
              : " Nobody else is on this project's team yet: add a team member to the project before this can be confirmed."}
          </p>
        )
      ) : null}

      {checks && box === "cancel" ? (
        <StepBox
          busy={actions.cancel.isPending}
          failed={
            actions.cancel.isError
              ? withReason("The task was not cancelled.", actions.cancel.error)
              : null
          }
          hint="Your reason is public, and the cancelled task stays on the project's record."
          note={{
            label: "Why the task is cancelled",
            required: "Say why, so the helper knows.",
          }}
          onCancel={close}
          onSend={(draft) =>
            actions.cancel.mutate(
              { task: reference, note: draft.note },
              { onSuccess: done("The task is cancelled.") },
            )
          }
          send="Cancel the task"
          sending="Saving…"
          testId="task-cancel-box"
          title="Cancel the task"
        />
      ) : checks && box === null ? (
        <div className="mt-2">
          <Button
            aria-label={`Cancel the task: ${task.what}`}
            data-task-focus="cancel"
            onClick={() => open("cancel", "cancel")}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel task
          </Button>
        </div>
      ) : null}
    </li>
  );
}
