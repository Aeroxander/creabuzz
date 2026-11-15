/**
 * Under "Done means" in the form a task is made in: a plain warning when the words give a reviewer nothing to count or
 * open, or use vague words (`done-means-lint.ts`), and, when the server's AI service is on, a button that proposes
 * sharper words.
 *
 * The warning never blocks: the team decides what its words are. The proposal is the AI's reading of the words the team
 * typed; it is shown to the team to use, edit or leave, is never published and decides nothing. It belongs to the words
 * it read: once they change it is marked out of date instead of shown as if it still applied.
 */

import {
  AI_DISCLOSURE,
  doneMeansPrompt,
  parseDoneMeans,
} from "@creaton/core/launchpad/helperAi.ts";
import { useEffect, useRef, useState } from "react";

import { lintDoneMeans } from "@/features/work/lib/done-means-lint";
import { useLlmGateway } from "@/features/fleet/use-llm-gateway";
import { Button } from "@/shared/ui/button";

import { askAi } from "../ask-ai";
import { TASK_LIMITS } from "../lib/tasks";
import { FIELD_CLASS } from "./TaskParts";

/** Warnings wait for a few words, so a half-typed line is not told off. */
const LINT_AFTER = 12;

export function DoneMeansHelp({
  what,
  done,
  onUse,
}: {
  what: string;
  done: string;
  onUse: (words: string) => void;
}) {
  const gateway = useLlmGateway();
  const [proposal, setProposal] = useState<{
    words: string;
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

  const warnings = done.trim().length >= LINT_AFTER ? lintDoneMeans(done) : [];
  const prompt = doneMeansPrompt({ what, done });
  const asked = JSON.stringify(prompt);
  const current = proposal && proposal.asked === asked ? proposal : null;

  const ask = async () => {
    setBusy(true);
    setFailure(null);
    // A new try drops the old proposal, so a failed retry never sits beside an earlier one.
    setProposal(null);
    try {
      const words = parseDoneMeans(await askAi(prompt.system, prompt.user));
      if (!words) throw new Error("unreadable");
      if (mounted.current) setProposal({ words, asked });
    } catch (error) {
      setFailure(
        error instanceof Error && error.message !== "unreadable"
          ? error.message
          : "The AI's answer could not be read. Try again, or write it yourself.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="done-means-help">
      {warnings.length > 0 ? (
        <ul
          className="list-disc rounded-md bg-amber-50 py-1.5 pr-2 pl-6 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="done-means-lint"
        >
          {warnings.map((warning) => (
            <li data-kind={warning.kind} key={warning.kind}>
              {warning.message}
            </li>
          ))}
          <li className="list-none text-muted-foreground">
            This is a hint. You can make the task as it is.
          </li>
        </ul>
      ) : null}
      {gateway === "available" ? (
        <>
          <Button
            aria-busy={busy}
            className="w-fit"
            data-testid="done-means-ai"
            disabled={busy || done.trim() === ""}
            onClick={() => void ask()}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? "Thinking…" : "Suggest sharper words with AI"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {AI_DISCLOSURE} The suggestion is shown only to you, is not posted,
            and decides nothing.
          </span>
          {proposal && !current ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="done-means-ai-stale"
            >
              You changed the words since. Ask again to see a suggestion for
              them as they are now.
            </p>
          ) : null}
          {current ? (
            <ProposalBox
              key={current.words}
              onKeep={() => setProposal(null)}
              onUse={(words) => {
                setProposal(null);
                onUse(words);
              }}
              words={current.words}
            />
          ) : null}
          {failure ? (
            <p
              className="text-xs text-destructive"
              data-testid="done-means-ai-failed"
              role="alert"
            >
              {failure}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The suggested words, editable, with a way to use them or keep the team's own. */
function ProposalBox({
  words,
  onUse,
  onKeep,
}: {
  words: string;
  onUse: (words: string) => void;
  onKeep: () => void;
}) {
  const [edited, setEdited] = useState(words);
  return (
    <div
      className="rounded-md bg-sky-50 p-2 text-sky-900 dark:bg-sky-950 dark:text-sky-100"
      data-testid="done-means-ai-proposal"
    >
      <label className="text-xs font-medium" htmlFor="done-means-ai-words">
        Suggested words (edit them if you like)
      </label>
      <textarea
        className={FIELD_CLASS}
        id="done-means-ai-words"
        maxLength={TASK_LIMITS.done}
        onChange={(e) => setEdited(e.target.value)}
        rows={3}
        value={edited}
      />
      <div className="mt-1 flex flex-wrap gap-2">
        <Button
          data-testid="done-means-ai-use"
          disabled={edited.trim() === ""}
          onClick={() => onUse(edited.trim())}
          size="sm"
          type="button"
        >
          Use these words
        </Button>
        <Button onClick={onKeep} size="sm" type="button" variant="outline">
          Keep my words
        </Button>
      </div>
    </div>
  );
}
