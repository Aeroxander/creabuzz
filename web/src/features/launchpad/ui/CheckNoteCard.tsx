/**
 * The check note on a contributor project's Overview (`checkNote.ts` in core, CHECK-NOTE-PLAN.md): when the last one
 * was, what it said changed and what the team changes next, and when the next is due. The founder writes it here: the
 * form starts with what the records say (each Now item's expectation, work finished and turned down since the last note,
 * turn-downs by cause, lapsed "taking this on" dates, work waiting on review) and asks for the rest.
 */

import { useMemo, useState } from "react";

import {
  type CheckNote,
  checkNoteProblem,
  checkTiming,
  coveredClaims,
  draftCheckNote,
  HAPPENED,
  type Happened,
  NEXT,
  type Next,
} from "@creaton/core/launchpad/checkNote.ts";
import type { WorkSnapshot } from "@creaton/core/launchpad/workRead.ts";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { causeLabel } from "../lib/review-reasons";
import { workTitle } from "../lib/work-titles";
import type { Launch } from "../models";
import { useCheckNotes } from "../use-check-notes";
import { useEvidencePackets } from "../use-evidence";
import { useProjectFocus, useTakenOn } from "../use-project-structure";
import { useReviewReasons } from "../use-review-reasons";
import { useRecordEvents } from "../use-work";
import { TextAreaField, TextField } from "./decision-fields";

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const HAPPENED_LABEL: Record<Happened, string> = {
  yes: "Yes",
  partly: "Partly",
  no: "No",
  "not-yet": "Not yet",
};
const NEXT_LABEL: Record<Next, string> = {
  keep: "Keep it",
  change: "Change it",
  drop: "Drop it",
};

export function CheckNoteCard({
  launch,
  dao,
  work,
}: {
  launch: Launch;
  dao: string;
  work: WorkSnapshot | undefined;
}) {
  const notes = useCheckNotes(launch);
  const founder = existingUserPubkey() === launch.record.author;
  const [writing, setWriting] = useState(false);
  const last = notes.query.data?.[0] ?? null;
  const timing = checkTiming(
    launch.record.createdAt,
    last?.createdAt ?? null,
    nowSeconds(),
  );

  if (notes.query.isError && !notes.query.data) {
    return (
      <Card className="p-4" data-testid="check-note">
        <h2 className="text-base font-bold">Check note</h2>
        <p className="mt-1 text-sm">Couldn&apos;t read the check notes.</p>
        <Button
          className="mt-2"
          onClick={() => void notes.query.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </Card>
    );
  }
  if (!notes.query.data) return null;

  if (writing) {
    return (
      <CheckNoteForm
        dao={dao}
        launch={launch}
        notes={notes}
        onDone={() => setWriting(false)}
        work={work}
      />
    );
  }

  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="check-note">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">Check note</h2>
        {founder ? (
          <Button
            data-testid="check-note-write"
            onClick={() => setWriting(true)}
            size="sm"
            type="button"
            variant={timing.due ? "default" : "outline"}
          >
            Write the check note
          </Button>
        ) : null}
      </div>
      <p
        className={
          timing.due
            ? "text-sm font-medium text-amber-800 dark:text-amber-300"
            : "text-sm text-muted-foreground"
        }
        data-testid="check-note-timing"
        role={timing.due ? "status" : undefined}
      >
        {timing.quiet
          ? `No check since ${day(last?.createdAt ?? launch.record.createdAt)}. One was due on ${day(timing.dueAt)}.`
          : timing.due
            ? `A check is due: what did the team expect, what happened, and what changes next?`
            : `${last ? `Last check: ${day(last.createdAt)}. ` : ""}Next check by ${day(timing.dueAt)}.`}
      </p>
      {last ? (
        <div
          className="flex flex-col gap-1 text-sm"
          data-testid="check-note-last"
        >
          <p>
            <span className="text-muted-foreground">What changed:</span>{" "}
            {last.outside}
          </p>
          <p>
            <span className="text-muted-foreground">What we change:</span>{" "}
            {last.change}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function CheckNoteForm({
  launch,
  dao,
  work,
  notes,
  onDone,
}: {
  launch: Launch;
  dao: string;
  work: WorkSnapshot | undefined;
  notes: ReturnType<typeof useCheckNotes>;
  onDone: () => void;
}) {
  const focus = useProjectFocus(launch);
  const takenOn = useTakenOn(launch);
  const evidence = useEvidencePackets(launch);
  const record = useRecordEvents(dao, work);
  const { reviewOf } = useReviewReasons(evidence.reasons, record.data);
  const ready =
    work !== undefined &&
    focus.query.data !== undefined &&
    takenOn.query.data !== undefined;
  const start = useMemo(() => {
    if (!ready) return null;
    const previous = notes.query.data ?? [];
    const claims = (work?.mandates ?? []).flatMap((m) =>
      m.claims.map((c) => ({
        key: `${m.address.toLowerCase()}:${c.id.toLowerCase()}`,
        title: workTitle(c.id),
        status: c.record.status,
        mandate: m.address,
        id: c.id,
      })),
    );
    return draftCheckNote({
      since: previous[0]?.createdAt ?? launch.record.createdAt,
      now: nowSeconds(),
      focus: focus.query.data?.now ?? [],
      claims,
      covered: coveredClaims(previous),
      causesOf: (key) => {
        const claim = claims.find((c) => c.key === key);
        return claim
          ? reviewOf(claim.mandate, claim.id).reasons.flatMap((r) =>
              r.cause ? [causeLabel(r.cause)] : [],
            )
          : [];
      },
      takings: takenOn.query.data ?? [],
    });
  }, [
    ready,
    notes.query.data,
    work,
    focus.query.data,
    takenOn.query.data,
    launch.record.createdAt,
    reviewOf,
  ]);
  const [edits, setEdits] = useState<CheckNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const note = edits ?? start;

  if (!note) {
    return (
      <Card
        className="p-4 text-sm text-muted-foreground"
        data-testid="check-note-form"
      >
        Reading the project&apos;s records…
      </Card>
    );
  }
  const problem = checkNoteProblem(note);
  const set = (patch: Partial<CheckNote>) => setEdits({ ...note, ...patch });
  const setItem = (i: number, patch: Partial<CheckNote["items"][number]>) =>
    set({
      items: note.items.map((item, j) =>
        j === i ? { ...item, ...patch } : item,
      ),
    });

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="check-note-form">
      <div>
        <h2 className="text-base font-bold">Check note</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Since {day(note.since)}: what the team expected, what happened, and
          what changes next. Holders read it before they vote on money.
        </p>
      </div>
      <TextAreaField
        hint="Start with them, not with the team's work. &quot;Nothing yet&quot; is an answer."
        label="What changed for the people the project is for"
        onChange={(outside) => set({ outside })}
        testId="check-note-outside"
        value={note.outside}
      />
      {note.items.map((item, i) => (
        <fieldset
          className="flex flex-col gap-2 rounded-lg bg-secondary/40 p-2"
          data-testid="check-note-item"
          // biome-ignore lint/suspicious/noArrayIndexKey: the Now list's own order
          key={`${i}-${item.text}`}
        >
          <legend className="px-1 text-sm font-medium">{item.text}</legend>
          {item.expected ? (
            <label className="grid gap-1 text-sm">
              <span>
                We expected: {item.expected}
                {item.checkBy ? `, by ${day(item.checkBy)}` : ""}. Did it
                happen?
              </span>
              <select
                className="h-8 w-fit rounded-md border border-input bg-transparent px-2 text-sm"
                data-testid={`check-note-happened-${i}`}
                onChange={(e) =>
                  setItem(i, {
                    happened: (e.target.value || null) as Happened | null,
                  })
                }
                value={item.happened ?? ""}
              >
                <option value="">Choose</option>
                {HAPPENED.map((h) => (
                  <option key={h} value={h}>
                    {HAPPENED_LABEL[h]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <TextField
            label="What you saw, in a line"
            onChange={(why) => setItem(i, { why })}
            testId={`check-note-why-${i}`}
            value={item.why}
          />
          <label className="grid gap-1 text-sm">
            <span>Knowing what you know now, would you start it today?</span>
            <select
              className="h-8 w-fit rounded-md border border-input bg-transparent px-2 text-sm"
              data-testid={`check-note-next-${i}`}
              onChange={(e) =>
                setItem(i, { next: (e.target.value || null) as Next | null })
              }
              value={item.next ?? ""}
            >
              <option value="">Choose</option>
              {NEXT.map((n) => (
                <option key={n} value={n}>
                  {NEXT_LABEL[n]}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      ))}
      <div
        className="flex flex-col gap-1 text-sm"
        data-testid="check-note-records"
      >
        <p>
          <span className="text-muted-foreground">Finished:</span>{" "}
          {note.finished.length
            ? note.finished.map((c) => c.title).join(", ")
            : "nothing new"}
        </p>
        <p>
          <span className="text-muted-foreground">Turned down:</span>{" "}
          {note.turnedDown.length
            ? `${note.turnedDown.length}${note.causes.length ? ` (${note.causes.map((c) => `${c.label}: ${c.count}`).join("; ")})` : ""}`
            : "none"}
        </p>
        {note.lapsed ? (
          <p>
            {note.lapsed} &ldquo;taking this on&rdquo; date
            {note.lapsed === 1 ? "" : "s"} passed without the work coming in.
          </p>
        ) : null}
      </div>
      <TextAreaField
        hint="Work waiting on someone, and who could unstick it."
        label="Stuck"
        onChange={(stuck) => set({ stuck })}
        testId="check-note-stuck"
        value={note.stuck}
      />
      <TextAreaField
        hint={
          note.causes[0]
            ? `Most work turned down lately: ${note.causes[0].label}. Fixing how work is set up there usually helps more than asking people to try harder.`
            : 'One change to how the team works: a clearer "done when", better context for someone\'s AI, a review rule.'
        }
        label="One thing we change in how we work"
        onChange={(change) => set({ change })}
        testId="check-note-change"
        value={note.change}
      />
      {problem || failure ? (
        <p
          className="text-sm text-destructive"
          data-testid="check-note-problem"
          role="alert"
        >
          {failure ?? problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          aria-busy={busy}
          data-testid="check-note-publish"
          disabled={busy || problem !== null}
          onClick={async () => {
            setBusy(true);
            setFailure(null);
            try {
              await notes.publish(note);
              onDone();
            } catch (error) {
              setFailure(
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              setBusy(false);
            }
          }}
          size="sm"
          type="button"
        >
          {busy ? "Publishing…" : "Publish the check note"}
        </Button>
        <Button
          disabled={busy}
          onClick={onDone}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </Card>
  );
}
