/**
 * "Check my work against the 'done when'" on the submit form (`helperAi.ts` in core, CHECK-AND-NEWCOMER-PLAN.md): when
 * the server's AI service is on, the AI lists what looks missing or unclear in the work as described. The form's words go
 * to that service; the answer is shown only to the person submitting, is never published and decides nothing. It reads
 * the form's text, not the pages links point to. A result belongs to the words it read: once they change, it is marked
 * as out of date rather than shown as if it still applied.
 */

import { useEffect, useRef, useState } from "react";

import {
  AI_DISCLOSURE,
  parseWorkCheck,
  workCheckPrompt,
} from "@creaton/core/launchpad/helperAi.ts";
import { useLlmGateway } from "@/features/fleet/use-llm-gateway";
import { Button } from "@/shared/ui/button";

import { askAi } from "../ask-ai";

export function WorkCheckAi(input: {
  doneWhen: string;
  evidence: string;
  met: string;
  notMet: string;
}) {
  const gateway = useLlmGateway();
  // The gaps, with the prompt they were read from: shown as current only while the form still says the same.
  const [result, setResult] = useState<{
    gaps: string[];
    asked: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (gateway !== "available") return null;
  const prompt = workCheckPrompt(input);
  const asked = JSON.stringify(prompt);
  const current = result && result.asked === asked ? result.gaps : null;
  const check = async () => {
    setBusy(true);
    setFailure(null);
    // A new try drops the old answer, so a failed retry never sits beside an earlier "nothing looks missing".
    setResult(null);
    try {
      const read = parseWorkCheck(await askAi(prompt.system, prompt.user));
      if (!read) throw new Error("unreadable");
      if (mounted.current) setResult({ gaps: read, asked });
    } catch (error) {
      setFailure(
        error instanceof Error && error.message !== "unreadable"
          ? error.message
          : "The AI's answer could not be read. Try again, or submit as it is.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="work-claim-ai">
      <Button
        aria-busy={busy}
        className="w-fit"
        data-testid="work-claim-ai-check"
        disabled={busy || input.evidence.trim() === ""}
        onClick={() => void check()}
        size="sm"
        type="button"
        variant="outline"
      >
        {busy ? "Checking…" : "Check my work against the words with AI"}
      </Button>
      <span className="text-xs text-muted-foreground">
        {AI_DISCLOSURE} The answer is shown only to you and is not posted. It
        reads what you typed, not the pages a link points to, and decides
        nothing.
      </span>
      {result && !current ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="work-claim-ai-stale"
        >
          You changed the words since the last check. Check again to see what
          looks missing now.
        </p>
      ) : null}
      {current ? (
        current.length === 0 ? (
          <p data-testid="work-claim-ai-none">
            Nothing looks missing from what you wrote.
          </p>
        ) : (
          <ul
            className="list-disc rounded-md bg-sky-50 py-1.5 pr-2 pl-6 text-sky-900 dark:bg-sky-950 dark:text-sky-100"
            data-testid="work-claim-ai-gaps"
          >
            {current.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        )
      ) : null}
      {failure ? (
        <p
          className="text-xs text-destructive"
          data-testid="work-claim-ai-failed"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </div>
  );
}
