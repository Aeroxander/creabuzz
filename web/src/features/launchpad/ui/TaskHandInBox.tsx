/**
 * The box a helper hands work in with: what they did, links and files (the shared step box), and beside them how they
 * checked it, optionally the numbers they report, and, for a labelled agent helper, whether every step was needed.
 *
 * - "How you checked it" and "What does not meet it yet" are the helper's own words, written into the hand-in under
 *   those labels. With the server's AI service on, "Check my work against the words with AI" lists what looks missing
 *   (`WorkCheckAi`): shown only to the helper, never posted, and it decides nothing.
 * - The numbers become `task-result` tags. They are shown to everyone as reported by the helper, not run by anyone else.
 * - "Was every step needed?" is for an agent account only: a person is not asked it.
 *
 * What was typed stays until the hand-in is sent: a send that fails leaves every field where it is.
 */

import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import {
  EMPTY_RESULT,
  handInNote,
  handInWordsProblem,
  readResultDrafts,
  type ResultDraft,
} from "../lib/hand-in-draft";
import { type ReportedResult, RESULT_LIMITS } from "../lib/task-results";
import { type TaskFile, TASK_LIMITS } from "../lib/tasks";
import { FIELD_CLASS, StepBox } from "./TaskParts";
import { WorkCheckAi } from "./WorkCheckAi";

export interface HandIn {
  note: string;
  links: string[];
  files: TaskFile[];
  results: ReportedResult[];
}

const FIELDS: readonly {
  key: keyof ResultDraft;
  label: string;
  max: number;
  inputMode?: "decimal" | "numeric";
}[] = [
  { key: "name", label: "Name", max: RESULT_LIMITS.name },
  {
    key: "value",
    label: "Value",
    max: RESULT_LIMITS.number,
    inputMode: "decimal",
  },
  { key: "unit", label: "Unit", max: RESULT_LIMITS.unit },
  {
    key: "baseline",
    label: "Compared with",
    max: RESULT_LIMITS.number,
    inputMode: "decimal",
  },
  {
    key: "sampleSize",
    label: "Sample size",
    max: RESULT_LIMITS.sampleDigits,
    inputMode: "numeric",
  },
  {
    key: "producedBy",
    label: "What produced it",
    max: RESULT_LIMITS.producedBy,
  },
];

export function TaskHandInBox({
  done,
  agent,
  busy,
  failed,
  onSend,
  onCancel,
}: {
  /** The task's "Done means": what the AI check compares the work with. */
  done: string;
  /** The helper is a labelled agent account: it is also asked whether every step was needed. */
  agent: boolean;
  busy: boolean;
  failed: string | null;
  onSend: (handIn: HandIn) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [checked, setChecked] = useState("");
  const [notMet, setNotMet] = useState("");
  const [steps, setSteps] = useState("");
  const [rows, setRows] = useState<ResultDraft[]>([]);

  const wordsOf = (typed: { note: string }) => ({
    did: typed.note,
    checked,
    notMet,
    stepsNeeded: agent ? steps : "",
  });

  return (
    <StepBox
      busy={busy}
      evidence
      extra={(typed) => (
        <>
          <p className="mt-3 text-sm font-semibold">How you checked it</p>
          <p
            className="text-xs text-muted-foreground"
            id={`${id}-checked-hint`}
          >
            Say what you ran or looked at, and what is still missing. These
            words are public with the rest of your hand-in.
          </p>
          <label
            className="mt-1 block text-sm font-medium"
            htmlFor={`${id}-checked`}
          >
            What you checked, and how
          </label>
          <textarea
            aria-describedby={`${id}-checked-hint`}
            className={FIELD_CLASS}
            data-testid="hand-in-checked"
            id={`${id}-checked`}
            maxLength={TASK_LIMITS.note}
            onChange={(e) => setChecked(e.target.value)}
            rows={2}
            value={checked}
          />
          <label
            className="mt-2 block text-sm font-medium"
            htmlFor={`${id}-not-met`}
          >
            What does not meet “Done means” yet (optional)
          </label>
          <textarea
            className={FIELD_CLASS}
            data-testid="hand-in-not-met"
            id={`${id}-not-met`}
            maxLength={TASK_LIMITS.note}
            onChange={(e) => setNotMet(e.target.value)}
            rows={2}
            value={notMet}
          />
          {agent ? (
            <>
              <label
                className="mt-2 block text-sm font-medium"
                htmlFor={`${id}-steps`}
              >
                Was every step needed? (optional)
              </label>
              <textarea
                className={FIELD_CLASS}
                data-testid="hand-in-steps"
                id={`${id}-steps`}
                maxLength={TASK_LIMITS.note}
                onChange={(e) => setSteps(e.target.value)}
                placeholder="Which steps were needed, and which could have been skipped."
                rows={2}
                value={steps}
              />
            </>
          ) : null}
          <div className="mt-2">
            <WorkCheckAi
              doneWhen={done}
              evidence={[typed.note, ...typed.links].join("\n")}
              met={checked}
              notMet={notMet}
            />
          </div>
          <p className="mt-3 text-sm font-semibold">Numbers (optional)</p>
          <p className="text-xs text-muted-foreground">
            If “Done means” is a number, report yours. Everyone sees it as
            reported by you, not run by anyone else.
          </p>
          {rows.map((row, i) => (
            <fieldset
              className="mt-2 rounded-md border border-border p-2"
              data-testid="hand-in-result"
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own; they are only ever added at the end or removed whole
              key={i}
            >
              <legend className="px-1 text-xs font-medium">
                Number {i + 1}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {FIELDS.map((field) => (
                  <label
                    className="flex flex-col text-xs font-medium"
                    key={field.key}
                  >
                    {field.label}
                    <input
                      className={FIELD_CLASS}
                      data-testid={`hand-in-result-${field.key}`}
                      inputMode={field.inputMode}
                      maxLength={field.max}
                      onChange={(e) =>
                        setRows((list) =>
                          list.map((r, at) =>
                            at === i
                              ? { ...r, [field.key]: e.target.value }
                              : r,
                          ),
                        )
                      }
                      value={row[field.key]}
                    />
                  </label>
                ))}
              </div>
              <Button
                aria-label={`Remove number ${i + 1}`}
                className="mt-2"
                onClick={() =>
                  setRows((list) => list.filter((_, at) => at !== i))
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5" /> Remove
              </Button>
            </fieldset>
          ))}
          <Button
            className="mt-2"
            data-testid="hand-in-add-result"
            disabled={rows.length >= RESULT_LIMITS.results}
            onClick={() => setRows((list) => [...list, { ...EMPTY_RESULT }])}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden className="h-3.5 w-3.5" /> Add a number
          </Button>
        </>
      )}
      extraProblem={(typed) => {
        const read = readResultDrafts(rows);
        return "problem" in read
          ? read.problem
          : handInWordsProblem(wordsOf(typed));
      }}
      failed={failed}
      hint="What you hand in is public: anyone can read it."
      note={{
        label: "What you did",
        placeholder: "What was done, and where to look.",
      }}
      onCancel={onCancel}
      onSend={(draft) => {
        const read = readResultDrafts(rows);
        onSend({
          note: handInNote(wordsOf(draft)),
          links: draft.links,
          files: draft.files,
          results: "results" in read ? read.results : [],
        });
      }}
      send="Hand in"
      sending="Handing in…"
      testId="task-hand-in-box"
      title="Hand in work"
    />
  );
}
