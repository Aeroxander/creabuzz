/**
 * Start a project with four answers: its name, one sentence, the goal, and how everyone will know.
 *
 * It makes a public project page with no Shares, no money and no reviewers, so one person can finish it alone in under
 * a minute. Everything else (rooms, boards, Shares for people who help) is set up later from the project page.
 *
 * The project is published first, then its goal (`lib/quick-start.ts`). When the goal does not go through, the form
 * says the project was made, keeps what was written, and "Try again" sends only the goal. Someone without an account
 * gets the sign-up dialog when they press the button, and finds what they typed still here afterwards.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { GOAL_LIMITS, newGoalId } from "@/features/launchpad/lib/goals";
import { IDEA_PITCH_MAX, ideaToInput } from "@/features/launchpad/lib/idea";
import { helpQueryKey } from "@/features/launchpad/use-help-requests";
import { EMPTY_CHAT } from "@/features/launchpad/use-launch-chat";
import {
  useCreateLaunch,
  useLaunches,
  useRemovedLaunchIds,
} from "@/features/launchpad/use-launches";
import { publishGoal } from "@/features/launchpad/use-project-record";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";

import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";
import { Input } from "@/shared/ui/input";

import { freshLaunchId } from "../lib/contributor-gate";
import {
  EMPTY_QUICK_START,
  loadMadeProject,
  loadQuickStart,
  type MadeProject,
  saveMadeProject,
  type QuickStartDraft,
  quickStartGoal,
  quickStartIssue,
  saveQuickStart,
} from "../lib/quick-start";

/** What happened in this form's own words, with the server's reason kept for whoever helps. */
function failed(text: string, cause: unknown): FailureWords {
  const reason = failureWords(cause);
  return { text, detail: reason.detail ?? reason.text };
}

const AREA_CLASS =
  "mt-1 w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm";

export function QuickStartForm() {
  const me = existingUserPubkey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useCreateLaunch();
  const launches = useLaunches();
  const removed = useRemovedLaunchIds(me);
  const [draft, setDraft] = useState<QuickStartDraft>(() =>
    loadQuickStart(sessionStorage),
  );
  const [issue, setIssue] = useState<string | null>(null);
  const [failure, setFailure] = useState<FailureWords | null>(null);
  const [busy, setBusy] = useState(false);
  // The project this visit already made, when its goal is still to be saved: a retry sends the goal, never a second
  // project. The goal keeps one id across retries, so a retried send is the same goal.
  const [made, setMadeState] = useState<MadeProject | null>(() =>
    loadMadeProject(sessionStorage, me),
  );
  const setMade = (next: MadeProject | null) => {
    saveMadeProject(sessionStorage, next);
    setMadeState(next);
  };
  const goalId = useRef(newGoalId());

  useEffect(() => {
    saveQuickStart(sessionStorage, draft);
  }, [draft]);

  const set = (field: keyof QuickStartDraft) => (value: string) => {
    setDraft((was) => ({ ...was, [field]: value }));
    setIssue(null);
  };

  // A new project's id must not be one this person used before, so both lists are read first.
  const listsFailed = me !== null && (launches.isError || removed.isError);
  const listsRead = me === null || (launches.isSuccess && removed.isSuccess);

  const submit = async () => {
    if (busy) return;
    const problem = quickStartIssue(draft);
    setIssue(problem);
    if (problem) return;
    // Signed out: the account dialog. What was typed is kept for when they come back.
    if (me === null) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    if (!listsRead) return;
    setBusy(true);
    setFailure(null);
    let project = made;
    try {
      if (!project) {
        const id = freshLaunchId({
          name: draft.name,
          mine: (launches.data ?? [])
            .filter((launch) => launch.record.author === me)
            .map((launch) => launch.record.id),
          removed: removed.data ?? [],
        });
        const event = await create.mutateAsync(
          ideaToInput({
            id,
            name: draft.name,
            pitch: draft.pitch,
            chat: EMPTY_CHAT,
          }),
        );
        project = { id, author: event.pubkey };
        setMade(project);
      }
    } catch (cause) {
      setFailure(
        failed(
          "Your project was not started. What you wrote is still here. Try again.",
          cause,
        ),
      );
      setBusy(false);
      return;
    }
    try {
      await publishGoal(project, quickStartGoal(draft, goalId.current));
      void queryClient.invalidateQueries({ queryKey: helpQueryKey });
      saveQuickStart(sessionStorage, null);
      saveMadeProject(sessionStorage, null);
      void navigate({
        to: "/launchpad/$launchId",
        params: { launchId: project.id },
        search: { author: project.author, action: undefined },
      });
    } catch (cause) {
      setFailure(
        failed(
          "Your project was made, but its goal was not saved. Try again.",
          cause,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-labelledby="quick-start-heading"
      className="flex flex-col gap-4 rounded-2xl border border-primary/60 bg-primary/5 p-5"
      data-testid="quick-start"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 className="text-base font-bold" id="quick-start-heading">
          What is your goal, and how will we know?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Four answers make a public project page. No money, no Shares, and
          nobody else needed. You can change any of it later.
        </p>
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="quick-name">
          Project name
        </label>
        <Input
          className="mt-1 bg-background"
          data-testid="quick-name"
          disabled={made !== null}
          id="quick-name"
          maxLength={60}
          onChange={(event) => set("name")(event.target.value)}
          placeholder="Nebula"
          value={draft.name}
        />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="quick-pitch">
          What is it, in one sentence?
        </label>
        <Input
          className="mt-1 bg-background"
          data-testid="quick-pitch"
          disabled={made !== null}
          id="quick-pitch"
          maxLength={IDEA_PITCH_MAX}
          onChange={(event) => set("pitch")(event.target.value)}
          placeholder="A free map of the night sky that anyone can add to."
          value={draft.pitch}
        />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="quick-goal">
          The goal
        </label>
        <textarea
          className={`${AREA_CLASS} bg-background`}
          data-testid="quick-goal"
          id="quick-goal"
          maxLength={GOAL_LIMITS.text}
          onChange={(event) => set("goal")(event.target.value)}
          placeholder="A first version that ten people use."
          rows={2}
          value={draft.goal}
        />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="quick-how">
          How we'll know
        </label>
        <textarea
          className={`${AREA_CLASS} bg-background`}
          data-testid="quick-how"
          id="quick-how"
          maxLength={GOAL_LIMITS.how}
          onChange={(event) => set("how")(event.target.value)}
          placeholder="Ten people sign in during the same week."
          rows={2}
          value={draft.how}
        />
      </div>
      {issue ? (
        <p
          className="text-sm text-red-700 dark:text-red-300"
          data-testid="quick-issue"
          role="alert"
        >
          {issue}
        </p>
      ) : null}
      {failure && !busy ? (
        <FailureNote failure={failure} testId="quick-failed" />
      ) : null}
      {made && !busy ? (
        <p className="text-sm" data-testid="quick-made">
          <Link
            className="font-semibold underline"
            params={{ launchId: made.id }}
            search={{ author: made.author, action: undefined }}
            to="/launchpad/$launchId"
          >
            Open your project
          </Link>{" "}
          to set its goal there instead.{" "}
          <Button
            className="h-auto p-0"
            onClick={() => {
              setMade(null);
              setFailure(null);
              setDraft(EMPTY_QUICK_START);
              goalId.current = newGoalId();
            }}
            size="sm"
            type="button"
            variant="link"
          >
            Or start a different project
          </Button>
        </p>
      ) : null}
      {listsFailed ? (
        <p className="text-sm" data-testid="quick-lists-failed" role="alert">
          Couldn't check your earlier projects, so a new one can't be started
          yet.{" "}
          <Button
            onClick={() => {
              void launches.refetch();
              void removed.refetch();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : null}
      <SignRecovery
        onUnlocked={() => void submit()}
        showHeadline
        testId="quick-sign-recovery"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="quick-start-go"
          disabled={busy || listsFailed || (me !== null && !listsRead)}
          type="submit"
        >
          {busy
            ? "Starting…"
            : made
              ? "Try again"
              : failure
                ? "Try again"
                : "Start the project"}
        </Button>
        {me === null ? (
          <span className="text-xs text-muted-foreground">
            You'll be asked to create your account first. What you typed stays
            here.
          </span>
        ) : null}
      </div>
    </form>
  );
}
