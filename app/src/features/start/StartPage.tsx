import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import { userPubkey } from "@creaton/core/client/identity.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ScreenHeader } from "../../app/BackHeader";
import { publishAsUser, read } from "../../lib/relay";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { Field, TextArea } from "../../ui/field";
import { useToast } from "../../ui/toast";
import { projectRef } from "../project/project-record";
import {
  EMPTY_START,
  GOAL_LIMITS,
  goalRecordTemplate,
  NAME_MAX,
  projectId,
  projectRecordTemplate,
  type StartDraft,
  missingAnswers,
  startProblems,
  startReady,
} from "./start-record";

/** What is typed is kept for this visit, so signing up or a failed send does not lose it. */
const DRAFT_KEY = "creaton.app.start-draft";

function loadDraft(): StartDraft {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const d = parsed as Record<string, unknown>;
      return {
        name: typeof d.name === "string" ? d.name : "",
        goal: typeof d.goal === "string" ? d.goal : "",
        how: typeof d.how === "string" ? d.how : "",
      };
    }
  } catch {
    // Nothing kept, or storage refused.
  }
  return EMPTY_START;
}

function saveDraft(draft: StartDraft | null) {
  try {
    if (draft) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage refused: the draft lives as long as the screen.
  }
}

/**
 * Start a project with three answers and one press: its name, what it will make, and how people will know it worked.
 * Nothing else is asked; everything else has a default or is set up later from the project page.
 */
export function StartPage() {
  const [draft, setDraft] = useState<StartDraft>(loadDraft);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const requireAccount = useRequireAccount();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  useEffect(() => saveDraft(draft), [draft]);
  // After a press with answers missing, each empty box says what it needs, and the first one takes the focus.
  const [tried, setTried] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (tried > 0)
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [tried]);
  const problems = {
    ...(tried > 0 ? missingAnswers(draft) : {}),
    ...startProblems(draft),
  };
  const set = (field: keyof StartDraft) => (value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));

  const start = async () => {
    setSending(true);
    setProblem(null);
    try {
      const me = userPubkey();
      const mine = await read({
        kinds: [KIND_LAUNCH_RECORD],
        authors: [me],
        limit: 200,
      });
      const taken = new Set(
        mine.flatMap((e) =>
          e.tags.filter((t) => t[0] === "d").map((t) => t[1]),
        ),
      );
      const id = projectId(draft.name, (candidate) => taken.has(candidate));
      const now = Math.floor(Date.now() / 1000);
      await publishAsUser(
        projectRecordTemplate(id, draft, now),
        "Your project was not saved. Try again.",
      );
      try {
        await publishAsUser(
          goalRecordTemplate(me, id, draft),
          "Your goal was not saved.",
        );
      } catch {
        // The project exists without its goal; its page asks the founder to set one.
        toast(
          "Your project is started. Its goal was not saved: add it on the project.",
          "problem",
        );
      }
      saveDraft(null);
      setDraft(EMPTY_START);
      await queryClient.invalidateQueries();
      void navigate({
        to: "/p/$ref",
        params: { ref: projectRef({ id, author: me }) },
      });
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Your project was not saved. Try again.",
      );
      setSending(false);
    }
  };

  return (
    <main className="screen mx-auto flex max-w-lg flex-col gap-6">
      <ScreenHeader title="Start a project" />
      <p className="-mt-3 text-muted">
        Three answers. You can change them later, and nothing costs anything.
      </p>
      <form
        className="flex flex-col gap-5"
        data-testid="start-form"
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (sending) return;
          if (!startReady(draft)) {
            setTried((n) => n + 1);
            return;
          }
          requireAccount(() => void start());
        }}
      >
        <Field
          autoComplete="off"
          count={{ used: draft.name.trim().length, max: NAME_MAX }}
          data-testid="start-name"
          label="Name"
          onChange={(e) => set("name")(e.target.value)}
          placeholder="For example: Night Sky Maps"
          problem={problems.name}
          value={draft.name}
        />
        <TextArea
          count={{ used: draft.goal.trim().length, max: GOAL_LIMITS.text }}
          data-testid="start-goal"
          label="What will you make?"
          onChange={(e) => set("goal")(e.target.value)}
          placeholder="For example: a first version that ten people use."
          problem={problems.goal}
          rows={3}
          value={draft.goal}
        />
        <TextArea
          count={{ used: draft.how.trim().length, max: GOAL_LIMITS.how }}
          data-testid="start-how"
          label="How will people know it worked?"
          onChange={(e) => set("how")(e.target.value)}
          placeholder="For example: ten people use it every week."
          problem={problems.how}
          rows={2}
          value={draft.how}
        />
        {problem ? (
          <p className="text-sm text-danger" role="alert">
            {problem}
          </p>
        ) : null}
        <Button
          block
          data-testid="start-submit"
          disabled={sending}
          type="submit"
        >
          {sending ? "Starting…" : "Start"}
        </Button>
      </form>
    </main>
  );
}
