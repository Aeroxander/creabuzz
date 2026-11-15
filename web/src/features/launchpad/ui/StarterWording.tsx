/**
 * Starter wording for an AI project, where the founder writes (`lib/ai-starters.ts`): the first promises above "What's
 * next" on the first weekly update, and starter tasks in the form a task is made in.
 *
 * A press only fills a box the founder has not written in. Nothing is signed or sent by it: the founder edits or clears
 * the words, and the update or the task is published with their own press, as always. Each choice is a real button, so
 * the keyboard reaches it, and a kind's button says whether it is the one pressed.
 */

import { useState } from "react";

import { cn } from "@/shared/lib/cn";

import {
  type AiStarterKind,
  pressStarterPromises,
  replaceableByStarter,
  starterTasksLeft,
} from "../lib/ai-starters";

const CHIP_CLASS =
  "rounded-full border border-border px-3 py-1 text-xs font-medium max-sm:min-h-11 hover:bg-muted";
const CHIP_ON_CLASS = "border-primary bg-primary/10";

/** The first promises, one press per kind. Shown only while "What's next" is empty or holds an unedited starter. */
export function StarterPromises({
  kinds,
  next,
  onUse,
}: {
  kinds: readonly AiStarterKind[];
  /** What "What's next" holds now. */
  next: string;
  onUse: (text: string) => void;
}) {
  if (
    kinds.length === 0 ||
    !replaceableByStarter(
      next,
      kinds.map((kind) => kind.promises),
    )
  )
    return null;
  return (
    <fieldset
      className="m-0 mb-2 min-w-0 rounded-xl border border-border p-3"
      data-testid="update-starters"
    >
      <legend className="px-1 text-sm font-medium">
        First promises for an AI project (optional)
      </legend>
      <p className="text-xs text-muted-foreground">
        Pick the kind that fits and three first promises go into "What's next".
        Change or clear them before you publish. Nothing is posted until you do.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <button
            aria-pressed={next.trim() === kind.promises}
            className={cn(
              CHIP_CLASS,
              next.trim() === kind.promises && CHIP_ON_CLASS,
            )}
            data-testid={`update-starter-${kind.id}`}
            key={kind.id}
            onClick={() => onUse(pressStarterPromises(next, kind))}
            type="button"
          >
            {kind.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Starter tasks, one press each: pick a kind, then a task, and its words and its "Done means" go into the form. Shown
 * only while both boxes are empty or hold an unedited starter, and never a task the project already made.
 */
export function StarterTasks({
  kinds,
  made,
  what,
  done,
  onUse,
}: {
  kinds: readonly AiStarterKind[];
  /** The words of the tasks this project already has. */
  made: readonly string[];
  what: string;
  done: string;
  onUse: (task: { title: string; done: string }) => void;
}) {
  const [kindId, setKindId] = useState<string | null>(null);
  const all = kinds.flatMap((kind) => kind.tasks);
  if (
    kinds.length === 0 ||
    !replaceableByStarter(
      what,
      all.map((task) => task.title),
    ) ||
    !replaceableByStarter(
      done,
      all.map((task) => task.done),
    )
  )
    return null;
  const kind = kinds.find((option) => option.id === kindId) ?? null;
  const left = kind ? starterTasksLeft(kind, made) : [];
  return (
    <fieldset
      className="m-0 mb-2 min-w-0 rounded-lg border border-border p-2"
      data-testid="task-starters"
    >
      <legend className="px-1 text-sm font-medium">
        Starter tasks for an AI project (optional)
      </legend>
      <p className="text-xs text-muted-foreground">
        Pick a kind, then a task. Its words and its finish line go into the form
        for you to change.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {kinds.map((option) => (
          <button
            aria-pressed={kindId === option.id}
            className={cn(CHIP_CLASS, kindId === option.id && CHIP_ON_CLASS)}
            data-testid={`task-starter-kind-${option.id}`}
            key={option.id}
            onClick={() => setKindId(kindId === option.id ? null : option.id)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      {kind ? (
        left.length > 0 ? (
          <ul
            className="mt-2 flex flex-col gap-1"
            data-testid="task-starter-list"
          >
            {left.map((task) => (
              <li key={task.title}>
                <button
                  aria-pressed={what.trim() === task.title}
                  className={cn(
                    "w-full rounded-lg border border-border px-2 py-1.5 text-left text-sm max-sm:min-h-11 hover:bg-muted",
                    what.trim() === task.title && CHIP_ON_CLASS,
                  )}
                  data-testid="task-starter"
                  onClick={() => onUse(task)}
                  type="button"
                >
                  {task.title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            This project already has every starter task of this kind.
          </p>
        )
      ) : null}
    </fieldset>
  );
}
