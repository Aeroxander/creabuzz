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
  fetchOwnRecord,
  launchesQueryKey,
  useCreateLaunch,
  useOwnLaunchIds,
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
  quickStartProblem,
  readableSoon,
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
  // The person's own project ids, read by author to the end. The list of every project is cut at its newest records,
  // so an older project of theirs may not be in it, and a new one with its id would replace it.
  const ownIds = useOwnLaunchIds(me);
  const removed = useRemovedLaunchIds(me);
  const [draft, setDraft] = useState<QuickStartDraft>(() =>
    loadQuickStart(sessionStorage),
  );
  const [issue, setIssue] =
    useState<ReturnType<typeof quickStartProblem>>(null);
  // Both saved, but the server has not shown the project back yet: said, with the link, instead of opening a page
  // that would say it was not found.
  const [notShownYet, setNotShownYet] = useState(false);
  const fields = useRef<
    Partial<
      Record<keyof QuickStartDraft, HTMLInputElement | HTMLTextAreaElement>
    >
  >({});
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

  useEffect(() => {
    saveQuickStart(sessionStorage, draft);
  }, [draft]);

  const set = (field: keyof QuickStartDraft) => (value: string) => {
    setDraft((was) => ({ ...was, [field]: value }));
    setIssue(null);
  };

  // A new project's id must not be one this person used before, so both lists are read first.
  const listsFailed = me !== null && (ownIds.isError || removed.isError);
  const listsRead = me === null || (ownIds.isSuccess && removed.isSuccess);

  const submit = async () => {
    if (busy) return;
    const problem = quickStartProblem(draft);
    setIssue(problem);
    if (problem) {
      // The keyboard goes to the answer that is missing, which names the problem as its description.
      fields.current[problem.field]?.focus();
      return;
    }
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
        const taken = [...(ownIds.data ?? [])];
        let id = freshLaunchId({
          name: draft.name,
          mine: taken,
          removed: removed.data ?? [],
        });
        // Asked once more, by id, just before publishing: a project made a moment ago elsewhere is not replaced. If
        // this read fails, nothing is made.
        if (await fetchOwnRecord(me, id)) {
          taken.push(id);
          id = freshLaunchId({
            name: draft.name,
            mine: taken,
            removed: removed.data ?? [],
          });
        }
        const event = await create.mutateAsync(
          ideaToInput({
            id,
            name: draft.name,
            pitch: draft.pitch,
            chat: EMPTY_CHAT,
          }),
        );
        project = { id, author: event.pubkey, goalId: newGoalId() };
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
      await publishGoal(project, quickStartGoal(draft, project.goalId));
    } catch (cause) {
      setFailure(
        failed(
          "Your project was made, but its goal was not saved. Try again.",
          cause,
        ),
      );
      setBusy(false);
      return;
    }
    // Both are saved. The page is opened once the server shows the project back, so it never opens on "not found".
    saveQuickStart(sessionStorage, null);
    const { id, author } = project;
    const shown = await readableSoon(
      async () => (await fetchOwnRecord(author, id)) !== null,
    );
    void queryClient.invalidateQueries({ queryKey: helpQueryKey });
    await queryClient
      .invalidateQueries({ queryKey: launchesQueryKey })
      .catch(() => undefined);
    setBusy(false);
    if (!shown) {
      setNotShownYet(true);
      return;
    }
    saveMadeProject(sessionStorage, null);
    void navigate({
      to: "/launchpad/$launchId",
      params: { launchId: id },
      search: { author, action: undefined },
    });
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
          aria-describedby={issue?.field === "name" ? "quick-issue" : undefined}
          aria-invalid={issue?.field === "name" || undefined}
          ref={(el) => {
            if (el) fields.current.name = el;
          }}
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
          aria-describedby={
            issue?.field === "pitch" ? "quick-issue" : undefined
          }
          aria-invalid={issue?.field === "pitch" || undefined}
          ref={(el) => {
            if (el) fields.current.pitch = el;
          }}
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
          aria-describedby={issue?.field === "goal" ? "quick-issue" : undefined}
          aria-invalid={issue?.field === "goal" || undefined}
          ref={(el) => {
            if (el) fields.current.goal = el;
          }}
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
          aria-describedby={issue?.field === "how" ? "quick-issue" : undefined}
          aria-invalid={issue?.field === "how" || undefined}
          ref={(el) => {
            if (el) fields.current.how = el;
          }}
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
          id="quick-issue"
          role="alert"
        >
          {issue.message}
        </p>
      ) : null}
      {failure && !busy ? (
        <FailureNote failure={failure} testId="quick-failed" />
      ) : null}
      {notShownYet && made && !busy ? (
        <p className="text-sm" data-testid="quick-not-shown" role="status">
          Your project and its goal are saved. The server has not shown the
          project back yet, which can take a moment.
        </p>
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
          {notShownYet ? "in a moment." : "to set its goal there instead."}{" "}
          <Button
            className="h-auto p-0"
            onClick={() => {
              setMade(null);
              setFailure(null);
              setNotShownYet(false);
              setDraft(EMPTY_QUICK_START);
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
              void ownIds.refetch();
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
            : made || failure
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
