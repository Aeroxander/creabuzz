/**
 * One task on a project's page: what it is, what "done" means, who it is with, how it stands and when it is due, the
 * work handed in so far, and the steps the person looking may take.
 *
 * The helper can say yes, hand work in, ask for more time, or give up. Someone else on the team can confirm the work,
 * send it back with a reason, give more time, or cancel. The person who did the work is never offered "Confirm": when
 * they are also on the team the row says someone else has to, and when there is nobody else it says that too.
 *
 * A task given to someone who has not said yes names them only to the team and to that person.
 */

import { useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import { agentLabel } from "../lib/agent-label";
import {
  confirmRule,
  dueLine,
  REWARDS_LINE,
  TASK_STATE_LABEL,
  type TaskState,
  type TaskView,
} from "../lib/tasks";
import { HELP_SIZE_LABEL } from "../lib/weekly-update";
import type { Launch } from "../models";
import { EvidenceGoneError, type TaskSent, useTaskActions } from "../use-tasks";
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
  | "send-back"
  | "confirm"
  | "cancel"
  | { grant: string };

const ADOPTED =
  "An earlier try had already gone through, so it was saved as it was then.";

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

  const isHelper = viewer === task.helper;
  const onTeam = viewer !== null && team.has(viewer);
  /** The team's side of a task is someone on the team who is not doing it. */
  const checks = onTeam && !isHelper;
  const rule = confirmRule(task, team, viewer);
  const open = (next: Box) => {
    for (const action of Object.values(actions)) action.reset();
    setBox(next);
  };
  const close = () => {
    setBox(null);
    row.current?.focus();
  };
  const done = (said: string) => (sent: TaskSent) => {
    setBox(null);
    onSaid(sent.adopted && sent.changed ? `${said} ${ADOPTED}` : said);
  };

  const due = dueLine(task, dateWords);
  const named = task.state !== "offered" || isHelper || onTeam;
  const pendingAsk = task.moreTime.find((ask) => !ask.granted) ?? null;
  const canWork = task.state === "in-progress" || task.state === "sent-back";
  const reference = { id: task.id, helper: task.helper, madeBy: task.madeBy };

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
        {named ? (
          <>
            With <PersonLink name={names(task.helper)} pubkey={task.helper} />
            {task.helperAgent ? (
              <>
                {" "}
                <Chip data-testid="task-helper-agent" tone="info">
                  {agentLabel(
                    task.helperAgent.owner
                      ? names(task.helperAgent.owner)
                      : null,
                  )}
                </Chip>
              </>
            ) : null}
          </>
        ) : (
          "Offered to someone who has not said yes yet"
        )}
        {" · "}made by {names(task.madeBy)}
        {due ? (
          <>
            {" · "}
            <span data-testid="task-due">{due}</span>
          </>
        ) : null}
      </p>

      {task.evidence.length > 0 ? (
        <div className="mt-2 space-y-2">
          {task.evidence.map((piece, i) => (
            <EvidencePiece
              heading={
                task.evidence.length > 1
                  ? `Work handed in (${i + 1} of ${task.evidence.length})`
                  : "Work handed in"
              }
              key={piece.id}
              names={names}
              piece={piece}
            />
          ))}
        </div>
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
            typeof box === "object" && box?.grant === ask.id ? (
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
                  actions.grant.isError ? "More time was not given." : null
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
                onClick={() => open({ grant: ask.id })}
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
        <div className="mt-2" data-testid="task-answer">
          <p className="text-sm">
            {names(task.madeBy)} gave you this task. It is yours only if you say
            yes.
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
              disabled={actions.giveUp.isPending}
              onClick={() =>
                actions.giveUp.mutate(
                  { task: reference, note: "" },
                  { onSuccess: done("You said no to this task.") },
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {actions.giveUp.isPending ? "Saving…" : "No, not for me"}
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
              Your yes was not saved.
            </SendFailed>
          ) : null}
          {actions.giveUp.isError ? (
            <SendFailed
              onRetry={() =>
                actions.giveUp.mutate(
                  { task: reference, note: "" },
                  { onSuccess: done("You said no to this task.") },
                )
              }
              testId="task-decline-failed"
            >
              Your no was not saved.
            </SendFailed>
          ) : null}
        </div>
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
              actions.evidence.isError ? "Your work was not handed in." : null
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
            failed={actions.moreTime.isError ? "Your ask was not sent." : null}
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
            failed={actions.giveUp.isError ? "This was not saved." : null}
            hint="Giving up closes the task for you. It stays on the project's record and on yours."
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
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => open("hand-in")} size="sm" type="button">
              {task.evidence.length > 0 ? "Hand in again" : "Hand in work"}
            </Button>
            {canWork && !pendingAsk ? (
              <Button
                onClick={() => open("more-time")}
                size="sm"
                type="button"
                variant="outline"
              >
                Ask for more time
              </Button>
            ) : null}
            <Button
              onClick={() => open("give-up")}
              size="sm"
              type="button"
              variant="outline"
            >
              Give up
            </Button>
          </div>
        )
      ) : null}

      {/* Checking: only someone on the team who did not do the work. */}
      {task.state === "submitted" && task.waiting && onTeam ? (
        rule.may ? (
          box === "confirm" ? (
            <div
              className="mt-2 rounded-lg border border-border bg-background/70 p-2"
              data-testid="task-confirm-box"
            >
              <p className="text-sm">
                Confirm that this work meets “Done means”? It then shows as work
                accepted on the project's record and on {names(task.helper)}'s.
              </p>
              <p
                className="mt-1 text-xs text-muted-foreground"
                data-testid="task-rewards-line"
              >
                {REWARDS_LINE}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  disabled={actions.confirm.isPending}
                  onClick={() => {
                    const evidenceId = task.waiting?.id;
                    if (!evidenceId) return;
                    actions.confirm.mutate(
                      { task: reference, evidenceId },
                      {
                        onSuccess: done("You confirmed this work."),
                        onError: (error) => {
                          if (!(error instanceof EvidenceGoneError)) return;
                          setBox(null);
                          onSaid(
                            "That work was removed before you confirmed it, so nothing was confirmed.",
                          );
                        },
                      },
                    );
                  }}
                  size="sm"
                  type="button"
                >
                  {actions.confirm.isPending ? "Saving…" : "Yes, confirm"}
                </Button>
                <Button
                  disabled={actions.confirm.isPending}
                  onClick={close}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Not yet
                </Button>
              </div>
              {actions.confirm.isError &&
              !(actions.confirm.error instanceof EvidenceGoneError) ? (
                <SendFailed
                  onRetry={() => {
                    const evidenceId = task.waiting?.id;
                    if (evidenceId)
                      actions.confirm.mutate(
                        { task: reference, evidenceId },
                        { onSuccess: done("You confirmed this work.") },
                      );
                  }}
                  testId="task-confirm-failed"
                >
                  The work was not confirmed.
                </SendFailed>
              ) : null}
            </div>
          ) : box === "send-back" ? (
            <StepBox
              busy={actions.sendBack.isPending}
              failed={
                actions.sendBack.isError &&
                !(actions.sendBack.error instanceof EvidenceGoneError)
                  ? "The work was not sent back."
                  : null
              }
              hint="Your reason is public: anyone can read it."
              note={{
                label: "What is missing",
                placeholder: "What still has to happen for this to be done.",
                required: "Say what is missing, so the work can be finished.",
              }}
              onCancel={close}
              onSend={(draft) => {
                const evidenceId = task.waiting?.id;
                if (!evidenceId) return;
                actions.sendBack.mutate(
                  { task: reference, evidenceId, note: draft.note },
                  {
                    onSuccess: done("You sent this work back."),
                    onError: (error) => {
                      if (!(error instanceof EvidenceGoneError)) return;
                      setBox(null);
                      onSaid(
                        "That work was removed before you answered it, so nothing was sent.",
                      );
                    },
                  },
                );
              }}
              send="Send back"
              sending="Sending…"
              testId="task-send-back-box"
              title="Send the work back"
            />
          ) : box === null ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => open("confirm")} size="sm" type="button">
                Confirm it's done
              </Button>
              <Button
                onClick={() => open("send-back")}
                size="sm"
                type="button"
                variant="outline"
              >
                Send back
              </Button>
            </div>
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
          failed={actions.cancel.isError ? "The task was not cancelled." : null}
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
            onClick={() => open("cancel")}
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
