import { Bot } from "lucide-react";
import { useRef, useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import type { Project } from "../project/project-record";
import type { DraftLine, ManagerDraft } from "./manager-calls";
import {
  AI_SERVICE_FALLBACK,
  CAN_BE_WRONG_FALLBACK,
  leftOutWords,
} from "./manager-copy";
import { useManagerDraft } from "./use-manager";

/** What the weekly box may hold once a draft is used: its lines, one to a row. */
export function whatHappenedText(draft: ManagerDraft, max: number): string {
  return draft.whatHappened
    .map((line) => line.text.trim())
    .filter((text) => text !== "")
    .join("\n")
    .slice(0, max);
}

/**
 * An optional help on the weekly update: the founder asks for a draft, reads what it read and what it left out, and may
 * copy its "What happened" lines into the weekly box. It never fills "What's next" (those lines become promises, so the
 * founder types them), never posts, and shows only to the person who started the project.
 */
export function ManagerPanel({
  project,
  max,
  onUse,
}: {
  project: Project;
  /** The weekly box's longest text. */
  max: number;
  /** Put these lines in the weekly box. */
  onUse: (text: string) => void;
}) {
  const { pubkey } = useAccount();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const ask = useManagerDraft();
  /** Set while a request runs: a second press before the button shows it is busy asks nothing twice. */
  const asking = useRef(false);
  if (!pubkey || pubkey !== project.author) return null;

  const submit = async () => {
    if (asking.current) return;
    asking.current = true;
    try {
      await ask.mutateAsync({ project, answers: [answer] });
    } catch {
      // The failure is shown from the mutation's own state.
    } finally {
      asking.current = false;
    }
  };

  if (!open)
    return (
      <Button
        data-testid="manager-open"
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Bot aria-hidden="true" size={16} />
        Draft with the manager
      </Button>
    );

  const draft = ask.data;
  return (
    <section
      aria-label="The manager's draft"
      className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3"
      data-testid="manager-panel"
    >
      <TextArea
        count={{ used: answer.length, max: 1000 }}
        data-testid="manager-answer"
        hint="It reads your record. Tell it anything the record does not show."
        label="Anything it should know? (optional)"
        maxLength={1000}
        onChange={(event) => setAnswer(event.target.value)}
        rows={2}
        value={answer}
      />
      {ask.error ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="manager-problem"
          role="alert"
        >
          {ask.error instanceof Error
            ? ask.error.message
            : "The draft did not come. Write it yourself, or try again."}
        </p>
      ) : null}
      <Button
        data-testid="manager-ask"
        disabled={ask.isPending}
        onClick={() => void submit()}
        size="sm"
        type="button"
        variant="secondary"
      >
        {ask.isPending ? "Reading your record…" : "Get the draft"}
      </Button>
      {draft ? <Draft draft={draft} max={max} onUse={onUse} /> : null}
    </section>
  );
}

function Lines({ title, lines }: { title: string; lines: DraftLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-muted">{title}</h4>
      <ul className="flex flex-col gap-1.5 text-sm">
        {lines.map((line) => (
          <li key={`${line.from.join(",")}:${line.text}`}>
            {line.text}{" "}
            <span className="text-2xs text-muted">
              (from {line.from.join(", ")})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Draft({
  draft,
  max,
  onUse,
}: {
  draft: ManagerDraft;
  max: number;
  onUse: (text: string) => void;
}) {
  const left = leftOutWords({
    dropped: draft.dropped,
    blocked: draft.blocked,
    setAside: draft.setAside,
  });
  const empty =
    draft.thisWeek.length +
      draft.notDoing.length +
      draft.whatHappened.length ===
    0;
  return (
    <div className="flex flex-col gap-3" data-testid="manager-draft">
      <p className="text-xs text-muted" data-testid="manager-read">
        {draft.read}
      </p>
      {empty ? (
        <p className="text-sm" data-testid="manager-empty">
          Nothing in your record backs a draft yet. Write this week's line
          yourself.
        </p>
      ) : null}
      <Lines lines={draft.thisWeek} title="This week" />
      <Lines lines={draft.notDoing} title="Not doing" />
      <Lines lines={draft.whatHappened} title="What happened" />
      {draft.needsAPerson.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="manager-person">
          <h4 className="text-xs font-semibold text-muted">
            This needs a person
          </h4>
          <ul className="flex flex-col gap-1.5 text-sm">
            {draft.needsAPerson.map((n) => (
              <li key={`${n.topic}:${n.ask}`}>
                {n.ask} <span className="text-2xs text-muted">({n.topic})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {left ? (
        <p className="text-xs text-muted" data-testid="manager-left-out">
          {left}
        </p>
      ) : null}
      <p className="text-xs text-muted" data-testid="manager-wrong">
        {draft.canBeWrong || CAN_BE_WRONG_FALLBACK}{" "}
        {draft.notice || AI_SERVICE_FALLBACK}
      </p>
      {draft.whatHappened.length > 0 ? (
        <Button
          data-testid="manager-use"
          onClick={() => onUse(whatHappenedText(draft, max))}
          size="sm"
          type="button"
          variant="secondary"
        >
          Use as what happened
        </Button>
      ) : null}
    </div>
  );
}
