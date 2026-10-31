/**
 * On an open work area: who has said they are on it, until when, and what they will deliver for whom; and for you, a
 * way to say you are taking it on, change that, or let it go (`projectStructure.ts` in core, kind 37019). Saying so
 * reserves nothing and earns nothing: anyone can still submit, and Shares still come from review and the vote.
 */

import { Hand } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";

import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Input } from "@/shared/ui/input";

import {
  type TakenOn,
  type TakeOnDraft,
  takeOnDraft,
  takeOnFromDraft,
  takeOnProblem,
  takenOnTemplate,
  areaKey,
  myTaking,
  takersByArea,
} from "@creaton/core/launchpad/projectStructure.ts";
import type { OpenWorkArea } from "../lib/ways-to-help";
import type { Launch } from "../models";
import { useProjectFocus, useTakenOn } from "../use-project-structure";
import { FormField, TextField } from "./decision-fields";

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function TakeOnWork({
  area,
  launch,
  takers,
  mine,
  me,
  nameOf,
  inNow,
  publish,
}: {
  /** The work area, as `<budget>:<work-area-id>`. */
  area: string;
  /** The launch's coordinate. */
  launch: string;
  /** Who is on it now, soonest date first. */
  takers: readonly TakenOn[];
  /** Your own newest record on it, whatever its state. */
  mine: TakenOn | null;
  /** You, or null when not signed in. */
  me: string | null;
  nameOf: (pubkey: string) => string;
  /** The founder named this work area under Now. */
  inNow: boolean;
  publish: (template: {
    kind: number;
    tags: string[][];
    content: string;
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TakeOnDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const now = nowSeconds();
  const live = mine && !mine.released && mine.until > now ? mine : null;
  const lapsed = mine && !mine.released && mine.until <= now ? mine : null;
  const problem = draft && tried ? takeOnProblem(draft, now) : null;
  const errorFor = (field: keyof TakeOnDraft) =>
    problem?.field === field ? problem.message : null;

  const send = async (template: Parameters<typeof publish>[0]) => {
    setBusy(true);
    setFailure(null);
    try {
      await publish(template);
      setDraft(null);
      setTried(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="take-on">
      {inNow ? (
        <span>
          <Chip tone="success">Now</Chip>
        </span>
      ) : null}
      {takers.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm" data-testid="take-on-list">
          {takers.map((t) => (
            <li data-testid="take-on-person" key={t.author}>
              <span className="font-medium">
                {t.author === me ? "You" : nameOf(t.author)}
              </span>{" "}
              {t.author === me ? "are" : "is"} on this until {day(t.until)}:{" "}
              {t.deliver}, for {t.for}.
            </li>
          ))}
        </ul>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-testid="take-on-nobody"
        >
          Nobody has said they are on this yet.
        </p>
      )}
      {lapsed && !draft ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="take-on-lapsed"
        >
          Your date ({day(lapsed.until)}) has passed, so this is open again.
          Take it on again if you are still on it.
        </p>
      ) : null}

      {draft ? (
        <div
          className="flex flex-col gap-2 rounded-lg bg-secondary/40 p-2"
          data-testid="take-on-form"
        >
          <TextField
            error={errorFor("deliver")}
            label="What you will deliver"
            onChange={(value) => setDraft({ ...draft, deliver: value })}
            placeholder="A first guide to submitting work"
            testId="take-on-deliver"
            value={draft.deliver}
          />
          <TextField
            error={errorFor("for")}
            hint="The people it is for. Ask them what they need before you start."
            label="Who will use it"
            onChange={(value) => setDraft({ ...draft, for: value })}
            placeholder="New contributors"
            testId="take-on-for"
            value={draft.for}
          />
          <FormField
            error={errorFor("untilDay")}
            hint="If it passes, the work is open again and nobody is blamed."
            label="By when"
          >
            {(props) => (
              <Input
                {...props}
                data-testid="take-on-until"
                onChange={(e) =>
                  setDraft({ ...draft, untilDay: e.target.value })
                }
                type="date"
                value={draft.untilDay}
              />
            )}
          </FormField>
          <p className="text-xs text-muted-foreground">
            Saying so earns nothing and reserves nothing: anyone can still
            submit, and Shares come from review and the vote.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              aria-busy={busy}
              data-testid="take-on-save"
              disabled={busy}
              onClick={() => {
                setTried(true);
                if (takeOnProblem(draft, nowSeconds())) return;
                void send(
                  takeOnFromDraft(draft, { launch, area, now: nowSeconds() }),
                );
              }}
              size="sm"
              type="button"
            >
              {busy ? "Saving…" : live ? "Save" : "Take it on"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setTried(false);
                setFailure(null);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : me ? (
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid={live ? "take-on-change" : "take-on-open"}
            onClick={() => setDraft(takeOnDraft(nowSeconds(), mine))}
            size="sm"
            type="button"
            variant="outline"
          >
            <Hand aria-hidden className="size-3.5" />
            {live ? "Change" : "Take this on"}
          </Button>
          {live ? (
            <Button
              aria-busy={busy}
              data-testid="take-on-release"
              disabled={busy}
              onClick={() =>
                void send(
                  takenOnTemplate({
                    launch,
                    area,
                    deliver: live.deliver,
                    for: live.for,
                    until: live.until,
                    released: true,
                  }),
                )
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Let it go
            </Button>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p
          className="text-xs text-destructive"
          data-testid="take-on-failed"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What an Open work card shows about taking its area on: who is on it, whether it is under Now, and the form. For the
 * `taking` slot of `WaysToHelp`.
 */
export function useTakingSlot(
  launch: Launch,
): (area: OpenWorkArea) => ReactNode {
  const takenOn = useTakenOn(launch);
  const focus = useProjectFocus(launch);
  const me = existingUserPubkey();
  const records = takenOn.query.data;
  const takers = useMemo(
    () => takersByArea(records ?? [], nowSeconds()),
    [records],
  );
  const nameOf = useUserNames(
    useMemo(
      () => [...new Set((records ?? []).map((t) => t.author))],
      [records],
    ),
  );
  const nowAreas = useMemo(
    () =>
      new Set(
        (focus.query.data?.now ?? []).flatMap((item) =>
          item.area ? [item.area] : [],
        ),
      ),
    [focus.query.data],
  );
  const { coordinate, publish } = takenOn;
  return useCallback(
    (area: OpenWorkArea) => {
      const key = areaKey(area.mandate, area.id);
      return (
        <TakeOnWork
          area={key}
          inNow={nowAreas.has(key)}
          launch={coordinate}
          me={me}
          mine={myTaking(records ?? [], me, key)}
          nameOf={nameOf}
          publish={publish}
          takers={takers.get(key) ?? []}
        />
      );
    },
    [coordinate, me, nameOf, nowAreas, publish, records, takers],
  );
}
