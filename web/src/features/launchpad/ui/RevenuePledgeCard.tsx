/**
 * The team's revenue pledge (D78), on the project's Overview: what part of the project's net receipts it says it will
 * pay into the treasury, how often, until when, and the signed document it is written into. Money paid in raises every
 * Share's part of the treasury when someone leaves; nothing pays holders automatically. The card always says that the
 * contracts do not enforce the pledge. Only the project's author edits it.
 */

import { useState } from "react";
import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { recordToInput } from "../lib/record-input";
import {
  type PledgeDraft,
  type PledgeEvery,
  pledgeDraftFromRecord,
  pledgeFromDraft,
  pledgeSentence,
} from "../lib/revenue-pledge";
import type { Launch } from "../models";
import { useCreateLaunch } from "../use-launches";
import { IpDocumentField } from "./IpDocumentField";

const INPUT =
  "w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring dark:border-white/10 dark:bg-white/5";

const EVERY: { value: PledgeEvery; label: string }[] = [
  { value: "month", label: "Every month" },
  { value: "quarter", label: "Every quarter" },
  { value: "year", label: "Every year" },
];

function Editor({ launch, onDone }: { launch: Launch; onDone: () => void }) {
  const save = useCreateLaunch();
  const [draft, setDraft] = useState<PledgeDraft>(() =>
    pledgeDraftFromRecord(launch.record.revenuePledge),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const patch = (next: Partial<PledgeDraft>) =>
    setDraft((d) => ({ ...d, ...next }));

  const submit = async () => {
    const made = pledgeFromDraft(draft);
    if ("problem" in made) {
      setProblem(made.problem);
      return;
    }
    setProblem(null);
    try {
      // Every other field the record holds is carried through the save.
      await save.mutateAsync(
        recordToInput(launch.record, { revenuePledge: made.pledge }),
      );
      toast.success("Saved");
      onDone();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Couldn't save that. Try again.",
      );
    }
  };

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      data-testid="pledge-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Percent of net receipts</span>
          <input
            className={INPUT}
            data-testid="pledge-percent"
            inputMode="numeric"
            onChange={(event) => patch({ percent: event.target.value })}
            placeholder="20"
            value={draft.percent}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Paid in</span>
          <select
            className={INPUT}
            data-testid="pledge-every"
            onChange={(event) =>
              patch({ every: event.target.value as PledgeEvery })
            }
            value={draft.every}
          >
            {EVERY.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Until</span>
          <input
            className={INPUT}
            data-testid="pledge-until"
            onChange={(event) => patch({ until: event.target.value })}
            placeholder="Blank: for as long as it earns"
            value={draft.until}
          />
        </label>
      </div>
      <IpDocumentField
        hint="The signed document the pledge is written into, for example the operating agreement of the legal entity that holds the project's intellectual property (IP)."
        label="Where it is written"
        onChange={(document) => patch({ document })}
        slot="pledge"
        value={draft.document}
      />
      {problem ? (
        <p
          className="text-xs text-destructive"
          data-testid="pledge-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="pledge-save"
          disabled={save.isPending}
          size="sm"
          type="submit"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RevenuePledgeCard({ launch }: { launch: Launch }) {
  const [editing, setEditing] = useState(false);
  const me = existingUserPubkey();
  const mine =
    me !== null && me.toLowerCase() === launch.record.author.toLowerCase();
  const pledge = launch.record.revenuePledge;
  // Nothing to show a visitor when the team has said nothing.
  if (!pledge && !mine) return null;

  return (
    <Card className="p-4" data-testid="pledge-card">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold">What the project earns</h2>
        {mine && !editing ? (
          <Button
            data-testid="pledge-edit"
            onClick={() => setEditing(true)}
            size="sm"
            variant="outline"
          >
            {pledge ? "Edit" : "Add a pledge"}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-sm" data-testid="pledge-sentence">
        {pledge
          ? pledgeSentence(pledge)
          : "You have not pledged to pay in any of what the project earns. A pledge is how revenue reaches holders here: money paid in raises every Share's part of the project's money."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Net receipts means what is left of the project&apos;s income after its
        costs.
      </p>
      {pledge?.document ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <a
            className="underline"
            href={pledge.document.url}
            rel="noreferrer noopener"
            target="_blank"
          >
            {pledge.document.title}
          </a>{" "}
          · fingerprint {pledge.document.sha256.slice(0, 12)}…
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        Nothing is paid to holders automatically. What is paid in stays in the
        project&apos;s money, where every holder can leave with their part of
        it.
      </p>
      {editing ? (
        <Editor launch={launch} onDone={() => setEditing(false)} />
      ) : null}
    </Card>
  );
}
