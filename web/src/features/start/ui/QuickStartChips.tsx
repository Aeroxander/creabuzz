/**
 * The tap-to-fill parts of the Start form: example ways to say how we will know, the optional "What kind of project?"
 * row, and, for an AI project, starter wording from `aiProjectKinds.ts`.
 *
 * Everything here only fills editable text. Nothing is sent, and no chip is needed to start a project.
 */

import {
  AI_PROJECT_ACCOUNTABILITY,
  AI_PROJECT_KINDS,
  aiProjectKind,
} from "@creaton/core/launchpad/aiProjectKinds.ts";

import { START_CATEGORIES } from "@/features/launchpad/lib/categories";
import { cn } from "@/shared/lib/cn";

import { HOW_EXAMPLES } from "../lib/quick-start";

/** The category that brings in the AI starter wording. */
export const AI_CATEGORY = "AI agent or tool";

const CHIP_CLASS =
  "rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground/80 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const CHIP_ON_CLASS = "border-primary bg-primary/10 text-primary-ink";

/** A row of chips under a visible name: a fieldset, so the name is the group's accessible name. */
function ChipGroup({
  id,
  label,
  testId,
  children,
}: {
  id: string;
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" data-testid={testId} id={id}>
      <legend className="p-0 text-xs font-medium text-muted-foreground">
        {label}
      </legend>
      <div className="mt-1 flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

/** Example sentences for "How we'll know": a number by a date, a link people can open, a named person confirms. */
export function HowExampleChips({
  onPick,
}: {
  onPick: (text: string) => void;
}) {
  return (
    <ChipGroup
      id="quick-how-examples"
      label="Not sure? Tap an example, then edit it."
      testId="quick-how-examples"
    >
      {HOW_EXAMPLES.map((example) => (
        <button
          className={CHIP_CLASS}
          data-testid={`quick-how-${example.id}`}
          key={example.id}
          onClick={() => onPick(example.text)}
          type="button"
        >
          {example.label}
        </button>
      ))}
    </ChipGroup>
  );
}

/** The optional "What kind of project?" row. Tapping the chosen chip again clears it. */
export function CategoryChips({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <ChipGroup
      id="quick-category-label"
      label="What kind of project? (optional)"
      testId="quick-category"
    >
      {START_CATEGORIES.map((name) => (
        <button
          aria-pressed={value === name}
          className={cn(CHIP_CLASS, value === name && CHIP_ON_CLASS)}
          data-testid={`quick-category-${name.toLowerCase().replace(/\W+/g, "-")}`}
          key={name}
          onClick={() => onChange(value === name ? "" : name)}
          type="button"
        >
          {name}
        </button>
      ))}
    </ChipGroup>
  );
}

/** A suggestion that fills a box: its words are the button's name, so a screen reader hears what it will write. */
function SuggestionButton({
  text,
  testId,
  onPick,
}: {
  text: string;
  testId: string;
  onPick: (text: string) => void;
}) {
  return (
    <button
      className={cn(CHIP_CLASS, "rounded-lg text-left")}
      data-testid={testId}
      onClick={() => onPick(text)}
      type="button"
    >
      {text}
    </button>
  );
}

/**
 * For an AI project: who answers for agent work, then four kinds to pick from. A kind offers goal ideas and ways to say
 * how we will know (tap to fill), and lists three first promises and a few starter tasks to use later.
 */
export function AiProjectPanel({
  kind,
  onKind,
  onGoal,
  onHow,
}: {
  kind: string;
  onKind: (next: string) => void;
  onGoal: (text: string) => void;
  onHow: (text: string) => void;
}) {
  const chosen = aiProjectKind(kind);
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/60 p-3"
      data-testid="quick-ai"
    >
      <p className="text-sm" data-testid="quick-ai-accountability">
        {AI_PROJECT_ACCOUNTABILITY}
      </p>
      <ChipGroup
        id="quick-ai-kind-label"
        label="What kind of AI project? (optional)"
        testId="quick-ai-kinds"
      >
        {AI_PROJECT_KINDS.map((option) => (
          <button
            aria-pressed={kind === option.id}
            className={cn(CHIP_CLASS, kind === option.id && CHIP_ON_CLASS)}
            data-testid={`quick-ai-kind-${option.id}`}
            key={option.id}
            onClick={() => onKind(kind === option.id ? "" : option.id)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </ChipGroup>
      {chosen ? (
        <div className="flex flex-col gap-3" data-testid="quick-ai-starter">
          <p className="text-xs text-muted-foreground">{chosen.about}</p>
          <ChipGroup
            id="quick-ai-goals-label"
            label="Goal ideas. Tap one, then make it yours."
            testId="quick-ai-goals"
          >
            {chosen.goalHints.map((text, index) => (
              <SuggestionButton
                key={text}
                onPick={onGoal}
                testId={`quick-ai-goal-${index}`}
                text={text}
              />
            ))}
          </ChipGroup>
          <ChipGroup
            id="quick-ai-how-label"
            label="Ways to say how we'll know, with a number"
            testId="quick-ai-hows"
          >
            {chosen.howExamples.map((text, index) => (
              <SuggestionButton
                key={text}
                onPick={onHow}
                testId={`quick-ai-how-${index}`}
                text={text}
              />
            ))}
          </ChipGroup>
          <details data-testid="quick-ai-later">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
              First promises and tasks, for after you start
            </summary>
            <div className="mt-2 flex flex-col gap-2 text-sm">
              <p className="text-xs text-muted-foreground">
                Use these in your first weekly update and your first tasks.
                Change any of them.
              </p>
              <ol className="list-decimal pl-5">
                {chosen.promises.map((promise) => (
                  <li key={promise}>{promise}</li>
                ))}
              </ol>
              <ul className="list-disc pl-5">
                {chosen.tasks.map((task) => (
                  <li key={task.title}>
                    {task.title}
                    <span className="block text-xs text-muted-foreground">
                      Done when: {task.done}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
