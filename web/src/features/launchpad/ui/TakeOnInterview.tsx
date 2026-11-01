/**
 * "Help me fill this in" on a first "Take this on" (`helperAi.ts` in core, CHECK-AND-NEWCOMER-PLAN.md): when the
 * server's AI service is on, three short questions one at a time, then an AI draft of what to deliver, for whom and by
 * when. The answers go to the server's AI service and are not published; the draft lands in the form for the person to
 * read and change before saving. A draft that comes back after the form changed or closed is dropped: it was written
 * for words that are no longer there, and must not overwrite newer edits or reopen a cancelled form.
 */

import { useEffect, useRef, useState } from "react";

import {
  dayOf,
  type TakeOnDraft,
} from "@creaton/core/launchpad/projectStructure.ts";
import {
  AI_DISCLOSURE,
  fenceAiRequest,
  INTERVIEW_QUESTIONS,
  type InterviewAnswers,
  parseTakeOnDraft,
  takeOnDraftPrompt,
} from "@creaton/core/launchpad/helperAi.ts";
import { useLlmGateway } from "@/features/fleet/use-llm-gateway";
import { Button } from "@/shared/ui/button";

import { askAi } from "../ask-ai";
import { TextField } from "./decision-fields";

const NO_ANSWERS: InterviewAnswers = { good: "", time: "", care: "" };

export function TakeOnInterview({
  areaTitle,
  doneWhen,
  form,
  onDraft,
}: {
  areaTitle: string;
  doneWhen: string | null;
  /** The form as it is now: a draft is used only if it has not changed while the AI wrote it. */
  form: TakeOnDraft;
  onDraft: (draft: { deliver: string; for: string; untilDay: string }) => void;
}) {
  const gateway = useLlmGateway();
  const [step, setStep] = useState<number | null>(null);
  const [answers, setAnswers] = useState<InterviewAnswers>(NO_ANSWERS);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // What the request was written from, as it is now, and whether the form is still open (Cancel unmounts this).
  const latest = useRef({ answers, form, areaTitle, doneWhen });
  latest.current = { answers, form, areaTitle, doneWhen };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (gateway !== "available") return null;

  if (step === null) {
    return (
      <Button
        className="w-fit"
        data-testid="take-on-interview"
        onClick={() => setStep(0)}
        size="sm"
        type="button"
        variant="outline"
      >
        Help me fill this in
      </Button>
    );
  }

  const draft = async () => {
    setBusy(true);
    setFailure(null);
    const current = fenceAiRequest(
      () => latest.current,
      () => mounted.current,
    );
    try {
      const prompt = takeOnDraftPrompt({
        area: areaTitle,
        doneWhen,
        answers,
      });
      const read = parseTakeOnDraft(await askAi(prompt.system, prompt.user));
      if (!read) throw new Error("unreadable");
      if (!current()) {
        if (mounted.current)
          setFailure(
            "You changed the form while the AI was drafting, so its draft was set aside. Draft it again, or fill it in yourself.",
          );
        return;
      }
      onDraft({
        deliver: read.deliver,
        for: read.for,
        untilDay: dayOf(Math.floor(Date.now() / 1000) + read.days * 86_400),
      });
      setStep(null);
      setAnswers(NO_ANSWERS);
    } catch (error) {
      setFailure(
        error instanceof Error && error.message !== "unreadable"
          ? error.message
          : "The AI's answer could not be read. Try again, or fill it in yourself.",
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const question = INTERVIEW_QUESTIONS[step];
  return (
    <div
      className="flex flex-col gap-2 rounded-md bg-sky-50 p-2 dark:bg-sky-950"
      data-testid="take-on-interview-form"
    >
      {question ? (
        <>
          <TextField
            hint={`Question ${step + 1} of ${INTERVIEW_QUESTIONS.length}. Leave it empty to skip.`}
            label={question.label}
            onChange={(text) =>
              setAnswers({ ...answers, [question.key]: text })
            }
            testId={`take-on-interview-${question.key}`}
            value={answers[question.key]}
          />
          <Button
            className="w-fit"
            data-testid="take-on-interview-next"
            onClick={() => setStep(step + 1)}
            size="sm"
            type="button"
            variant="outline"
          >
            Next
          </Button>
        </>
      ) : (
        <Button
          aria-busy={busy}
          className="w-fit"
          data-testid="take-on-interview-draft"
          disabled={busy}
          onClick={() => void draft()}
          size="sm"
          type="button"
        >
          {busy ? "Drafting…" : "Draft it for me"}
        </Button>
      )}
      <span className="text-xs text-muted-foreground">
        {AI_DISCLOSURE} Your answers are not posted. The AI drafts the form; you
        read and change it before saving.
      </span>
      {failure ? (
        <p
          className="text-xs text-destructive"
          data-testid="take-on-interview-failed"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </div>
  );
}
