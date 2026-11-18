/**
 * "Draft from the record": a first version of "What happened this week", "Help needed" and "In one line" for the update
 * dialog, written by the server's AI service from the project's own record only (`updateAi.ts` in core): the work
 * accepted since the last update, last week's promises with the marks chosen so far, the goals and the help still wanted.
 * "What's next" is never drafted: those lines become promises, so they stay the founder's words.
 *
 * The draft goes only into boxes the founder has not written in, and nothing is published until they publish. When the
 * server's AI limit is reached, its own words are shown as they are (`ask-ai.ts`).
 */

import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  parseUpdateDraft,
  hasDraftMaterial,
  updateDraftPrompt,
} from "@creaton/core/launchpad/updateAi.ts";

import { useLlmGateway } from "@/features/fleet/use-llm-gateway";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { askAi } from "../ask-ai";
import { projectGoals } from "../lib/goals";
import { helpRequest, teamOf } from "../lib/help-request";
import type { MarkState, PromiseEntry } from "../lib/promises";
import {
  type DraftField,
  type DraftFields,
  draftFacts,
  placeDraft,
} from "../lib/update-draft-facts";
import { PART_HEADINGS } from "../lib/weekly-update";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";

const FIELD_NAME: Record<DraftField, string> = {
  done: PART_HEADINGS.done,
  help: PART_HEADINGS.help,
  line: PART_HEADINGS.line,
};

type Status =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "drafted"; dropped: number; kept: DraftField[] }
  | { kind: "failed"; words: string };

export function DraftFromRecord({
  project,
  accepted,
  due,
  marks,
  current,
  onFill,
}: {
  project: Launch["record"];
  /** The accepted work the founder has not taken off. */
  accepted: readonly { id: string; what: string }[];
  /** The promises still to answer. Null when they could not be read: the draft then has no promises to go on. */
  due: readonly PromiseEntry[] | null;
  marks: Readonly<Record<string, { state: MarkState; note: string }>>;
  /** What the three boxes hold right now. */
  current: () => DraftFields;
  /** Puts the draft in the boxes, and tells whether it filled "What happened" (so the dialog does not say it twice). */
  onFill: (next: DraftFields, filled: readonly DraftField[]) => void;
}) {
  const gateway = useLlmGateway();
  const read = useProjectUpdates(project);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "none" });
  const last = useRef<DraftFields | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const draft = async () => {
    const data = read.data;
    if (!data || busy) return;
    const team = teamOf(project);
    const me = existingUserPubkey();
    const goals = projectGoals(data.founder.goals, project.author);
    const facts = draftFacts({
      accepted,
      promises: due ?? [],
      marks,
      goals: [...(goals.primary ? [goals.primary] : []), ...goals.shorter],
      help: data.updates
        .filter((update) => update.help && team.has(update.author))
        .filter(
          (update) =>
            helpRequest({ update, signals: data.signals, team, viewer: me })
              ?.open,
        )
        .map((update) => update.help?.text ?? ""),
    });
    if (!hasDraftMaterial(facts)) {
      setStatus({ kind: "empty" });
      return;
    }
    const atClick = current();
    setBusy(true);
    setStatus({ kind: "none" });
    try {
      const { system, user } = updateDraftPrompt(facts);
      const reply = await askAi(system, user);
      const result = parseUpdateDraft(reply, facts);
      if (!alive.current) return;
      if (!result) {
        setStatus({
          kind: "failed",
          words:
            "The draft didn't match your record, so nothing was added. Try again, or write it yourself.",
        });
        return;
      }
      const placed = placeDraft({
        draft: { done: result.done, help: result.help, line: result.line },
        atClick,
        now: current(),
        last: last.current,
      });
      last.current = {
        done: placed.filled.includes("done")
          ? result.done
          : (last.current?.done ?? ""),
        help: placed.filled.includes("help")
          ? result.help
          : (last.current?.help ?? ""),
        line: placed.filled.includes("line")
          ? result.line
          : (last.current?.line ?? ""),
      };
      onFill(placed.next, placed.filled);
      setStatus({
        kind: "drafted",
        dropped: result.dropped,
        kept: placed.kept,
      });
    } catch (error) {
      if (alive.current)
        setStatus({
          kind: "failed",
          words:
            error instanceof Error
              ? error.message
              : "The AI service didn't answer. Write it yourself, or try again later.",
        });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // A server with no AI service has nothing to offer here: the button and its line are not shown.
  if (gateway !== "available") return null;
  return (
    <div className="flex flex-col gap-2" data-testid="update-draft">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="max-sm:h-11"
          data-testid="update-draft-button"
          disabled={busy || !read.data}
          onClick={() => void draft()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Sparkles aria-hidden className="mr-1.5 h-4 w-4" />
          {busy ? "Drafting…" : "Draft from the record"}
        </Button>
        <p
          className="min-w-48 flex-1 text-xs text-muted-foreground"
          data-testid="update-draft-line"
        >
          Drafts from your record and sends it to this server's AI service. You
          edit it before anything is posted.
        </p>
      </div>
      {status.kind === "empty" ? (
        <p className="text-sm" data-testid="update-draft-empty" role="status">
          There is nothing on the record to draft from yet: no accepted work,
          promises or help requests. Write this one yourself.
        </p>
      ) : null}
      {status.kind === "drafted" ? (
        <p className="text-sm" data-testid="update-draft-done" role="status">
          Drafted from your record. Read it, change what is wrong, and publish
          it when it is yours.
          {status.dropped > 0
            ? ` ${status.dropped} ${status.dropped === 1 ? "line was" : "lines were"} left out because your record doesn't back ${status.dropped === 1 ? "it" : "them"}.`
            : ""}
          {status.kept.length > 0
            ? ` Your own words in ${status.kept.map((f) => `"${FIELD_NAME[f]}"`).join(" and ")} were left as they are.`
            : ""}
        </p>
      ) : null}
      {status.kind === "failed" ? (
        <p
          className="text-sm text-red-700 dark:text-red-300"
          data-testid="update-draft-error"
          role="alert"
        >
          {status.words}
        </p>
      ) : null}
    </div>
  );
}
