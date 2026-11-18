/**
 * The project's aim, "Now" and "Not doing" on a contributor project's Overview (`projectStructure.ts` in core, kind
 * 37020): who the project is for and what it changes for them; the few things the team works on now, each with who
 * has taken it on, why it matters now, and what the team expects to see by a day it will check; and what it has
 * decided not to do. The founder sets them; after four weeks they are asked whether each Now item is still worth
 * doing, and a Now item says when its check day has come. Everyone else reads them.
 */

import { useMemo, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  areaKey,
  checkDue,
  dayEnd,
  dayOf,
  emptyFocusItem,
  type FocusDraft,
  type FocusItem,
  focusDueForReview,
  focusProblem,
  MAX_NOT_DOING,
  MAX_NOW,
  type NotDoingItem,
  takersByArea,
} from "@creaton/core/launchpad/projectStructure.ts";
import type { OpenWorkArea } from "../lib/ways-to-help";
import type { Launch } from "../models";
import { useProjectFocus, useTakenOn } from "../use-project-structure";
import { Input } from "@/shared/ui/input";

import { FormField, TextField } from "./decision-fields";

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function ProjectFocusCard({
  launch,
  areas,
  onOpenWork,
}: {
  launch: Launch;
  /** The open work areas, to name under a Now item and to pick from. */
  areas: readonly OpenWorkArea[];
  onOpenWork: () => void;
}) {
  const focus = useProjectFocus(launch);
  const takenOn = useTakenOn(launch);
  const me = existingUserPubkey();
  const founder = me !== null && me === launch.record.author;
  const takers = useMemo(
    () => takersByArea(takenOn.query.data ?? [], nowSeconds()),
    [takenOn.query.data],
  );
  const nameOf = useUserNames(
    useMemo(
      () => [...new Set((takenOn.query.data ?? []).map((t) => t.author))],
      [takenOn.query.data],
    ),
  );
  const titleOf = useMemo(() => {
    const titles = new Map(
      areas.map((a) => [areaKey(a.mandate, a.id), a.title] as const),
    );
    return (key: string) => titles.get(key) ?? null;
  }, [areas]);
  const [editing, setEditing] = useState<FocusDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const current = focus.query.data ?? null;
  const save = async (next: FocusDraft) => {
    setBusy(true);
    setFailure(null);
    try {
      await focus.save(next);
      setEditing(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (focus.query.isError && !current) {
    return (
      <Card className="p-4" data-testid="focus">
        <h2 className="text-base font-bold">Priorities</h2>
        <p className="mt-1 text-sm">
          Couldn&apos;t read what the team is working on now.
        </p>
        <Button
          className="mt-2"
          onClick={() => void focus.query.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </Card>
    );
  }
  // Nothing set and nothing to set: the card would only say so.
  if (!editing && !current && !founder) {
    return focus.query.isLoading ? null : (
      <Card className="p-4" data-testid="focus">
        <h2 className="text-base font-bold">Priorities</h2>
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="focus-unset"
        >
          The founder hasn&apos;t said yet what the team is working on now. Open
          work shows everything you can pick up.
        </p>
      </Card>
    );
  }

  if (editing) {
    const problem = focusProblem(editing);
    const setNow = (i: number, item: FocusItem) =>
      setEditing({
        ...editing,
        now: editing.now.map((n, j) => (j === i ? item : n)),
      });
    const setNot = (i: number, item: NotDoingItem) =>
      setEditing({
        ...editing,
        notDoing: editing.notDoing.map((n, j) => (j === i ? item : n)),
      });
    return (
      <Card className="flex flex-col gap-3 p-4" data-testid="focus-form">
        <div>
          <h2 className="text-base font-bold">Aim, Priorities and Not doing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick at most {MAX_NOW} priorities. A team gets more done on a few
            things at a time. For each, say what you expect to see and when you
            will check, so the team learns whether it worked. Then say what you
            have decided not to do, so nobody keeps working on it.
          </p>
        </div>
        <TextField
          hint="One sentence: who the project is for, and what it changes for them."
          label="Aim"
          onChange={(aim) => setEditing({ ...editing, aim })}
          placeholder="Teachers who want open lesson plans, written with them"
          testId="focus-aim-input"
          value={editing.aim}
        />
        {editing.now.map((item, i) => (
          <div
            className="flex flex-col gap-1 rounded-lg bg-secondary/40 p-2"
            // Rows are only added at the end and never reordered.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
            key={`now-${i}`}
          >
            <TextField
              label={`Priority ${i + 1}`}
              onChange={(text) => setNow(i, { ...item, text })}
              placeholder="Ship the first guide"
              testId={`focus-now-${i}`}
              value={item.text}
            />
            {areas.length > 0 ? (
              <select
                aria-label={`Work area for priority ${i + 1}`}
                className="h-8 w-fit rounded-md border border-input bg-transparent px-2 text-xs"
                data-testid={`focus-now-area-${i}`}
                onChange={(e) =>
                  setNow(i, { ...item, area: e.target.value || null })
                }
                value={item.area ?? ""}
              >
                <option value="">Not one work area</option>
                {areas.map((a) => {
                  const key = areaKey(a.mandate, a.id);
                  return (
                    <option key={key} value={key}>
                      {a.title}
                    </option>
                  );
                })}
              </select>
            ) : null}
            <TextField
              label="Why this, now"
              onChange={(why) => setNow(i, { ...item, why })}
              placeholder="Newcomers can't submit work without it"
              testId={`focus-now-why-${i}`}
              value={item.why}
            />
            <TextField
              hint="Something you can check: a number, a person's answer, a thing that exists."
              label="What we expect to see"
              onChange={(expect) => setNow(i, { ...item, expect })}
              placeholder="Three newcomers submit work"
              testId={`focus-now-expect-${i}`}
              value={item.expect}
            />
            <FormField label="Check by">
              {(props) => (
                <Input
                  {...props}
                  className="w-fit"
                  data-testid={`focus-now-check-${i}`}
                  onChange={(e) =>
                    setNow(i, {
                      ...item,
                      checkBy: e.target.value ? dayEnd(e.target.value) : null,
                    })
                  }
                  type="date"
                  value={item.checkBy === null ? "" : dayOf(item.checkBy)}
                />
              )}
            </FormField>
          </div>
        ))}
        {editing.now.length < MAX_NOW ? (
          <Button
            className="w-fit"
            data-testid="focus-now-add"
            onClick={() =>
              setEditing({
                ...editing,
                now: [...editing.now, emptyFocusItem()],
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Add a priority
          </Button>
        ) : null}
        {editing.notDoing.map((item, i) => (
          <div
            className="flex flex-col gap-1 rounded-lg bg-secondary/40 p-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
            key={`not-${i}`}
          >
            <TextField
              label={`Not doing ${i + 1}`}
              onChange={(text) => setNot(i, { ...item, text })}
              placeholder="A mobile app"
              testId={`focus-not-${i}`}
              value={item.text}
            />
            <TextField
              label="Why not, for now"
              onChange={(why) => setNot(i, { ...item, why })}
              placeholder="Not before the guide works"
              testId={`focus-not-why-${i}`}
              value={item.why}
            />
          </div>
        ))}
        {editing.notDoing.length < MAX_NOT_DOING ? (
          <Button
            className="w-fit"
            data-testid="focus-not-add"
            onClick={() =>
              setEditing({
                ...editing,
                notDoing: [...editing.notDoing, { text: "", why: "" }],
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Add to Not doing
          </Button>
        ) : null}
        {problem || failure ? (
          <p
            className="text-sm text-destructive"
            data-testid="focus-problem"
            role="alert"
          >
            {problem ?? failure}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            aria-busy={busy}
            data-testid="focus-save"
            disabled={busy || problem !== null}
            onClick={() => void save(editing)}
            size="sm"
            type="button"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setFailure(null);
            }}
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

  const startEditing = () =>
    setEditing({
      aim: current?.aim ?? "",
      now: current?.now.length ? current.now : [emptyFocusItem()],
      notDoing: current?.notDoing ?? [],
      // Kept through the edit, so the last check note still reads as applied (checkNote.ts).
      applied: current?.applied ?? null,
    });
  const review = current && founder && focusDueForReview(current, nowSeconds());

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="focus">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">Priorities</h2>
        {founder ? (
          <Button
            data-testid={current ? "focus-change" : "focus-set"}
            onClick={startEditing}
            size="sm"
            type="button"
            variant="outline"
          >
            {current ? "Change" : "Set priorities"}
          </Button>
        ) : null}
      </div>
      {review ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="focus-review"
          role="status"
        >
          <span>
            Set on {day(current.createdAt)}. If you weren&apos;t doing each of
            these yet, would you start it today?
          </span>
          <Button
            aria-busy={busy}
            data-testid="focus-still-right"
            disabled={busy}
            onClick={() =>
              void save({
                aim: current.aim,
                now: current.now,
                notDoing: current.notDoing,
                applied: current.applied,
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Yes, all of them
          </Button>
        </div>
      ) : null}
      {current?.aim ? (
        <p data-testid="focus-aim">
          <span className="font-medium">Aim:</span> {current.aim}
        </p>
      ) : founder ? (
        <p className="text-sm text-muted-foreground" data-testid="focus-no-aim">
          Add an aim: one sentence on who the project is for and what it changes
          for them, so every piece of work can be checked against it.
        </p>
      ) : null}
      {!current || current.now.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="focus-unset">
          Set at most {MAX_NOW} priorities, so everyone pulls the same way.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" data-testid="focus-now">
          {current.now.map((item, i) => {
            const on = item.area ? (takers.get(item.area) ?? []) : [];
            const title = item.area ? titleOf(item.area) : null;
            return (
              <li
                className="rounded-lg bg-secondary/40 px-3 py-2"
                data-testid="focus-now-item"
                // biome-ignore lint/suspicious/noArrayIndexKey: the founder's own order
                key={`${i}-${item.text}`}
              >
                <p className="font-medium">{item.text}</p>
                {item.why ? (
                  <p className="mt-0.5 text-sm" data-testid="focus-now-why">
                    <span className="text-muted-foreground">Why now:</span>{" "}
                    {item.why}
                  </p>
                ) : null}
                {item.expect && item.checkBy !== null ? (
                  <p className="mt-0.5 text-sm" data-testid="focus-now-expect">
                    <span className="text-muted-foreground">We expect:</span>{" "}
                    {item.expect}, by {day(item.checkBy)}.
                    {checkDue(item, nowSeconds()) ? (
                      <span
                        className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
                        data-testid="focus-now-check-due"
                      >
                        Time to check whether it happened
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {item.area ? (
                  <p
                    className="mt-0.5 text-xs text-muted-foreground"
                    data-testid="focus-now-who"
                  >
                    {title ? `${title}: ` : ""}
                    {on.length > 0 ? (
                      on
                        .map(
                          (t) =>
                            `${t.author === me ? "you" : nameOf(t.author)} until ${day(t.until)}`,
                        )
                        .join(", ")
                    ) : (
                      <>
                        nobody has taken this on yet.{" "}
                        <button
                          className="underline"
                          onClick={onOpenWork}
                          type="button"
                        >
                          Take it on
                        </button>
                      </>
                    )}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {current && current.notDoing.length > 0 ? (
        <div data-testid="focus-not-doing">
          <h3 className="text-sm font-semibold">Not doing</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {current.notDoing.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the founder's own order
              <li data-testid="focus-not-item" key={`${i}-${item.text}`}>
                {item.text}
                {item.why ? (
                  <span className="text-muted-foreground"> ({item.why})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {failure ? (
        <p className="text-sm text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
    </Card>
  );
}
