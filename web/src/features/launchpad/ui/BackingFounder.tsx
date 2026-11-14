/**
 * What a project's founder does about backing: open it (now, or behind a fair round with a minimum), and post a milestone
 * that points at one of the project's own public records. Both are sent from the account that made the project, or from
 * the project itself: the pool's contract says which, so a different account is told to switch before anything is signed.
 */

import {
  type NoPoolView,
  type PoolView,
  parseAmount,
} from "@creaton/core/launchpad/backing.ts";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  FOUNDER_ACCOUNT_LINE,
  NO_FOUNDER_LINE,
  NO_RECORDS_LINE,
  OPEN_NOW_HELP,
  OPEN_NOW_LABEL,
  OPEN_ROUND_HELP,
  OPEN_ROUND_LABEL,
  POST_MILESTONE_HELP,
  money,
  whenWords,
} from "../lib/backing-copy";
import { openBackingCalls, postMilestoneCalls } from "../lib/backing-orders";
import { KIND_WORD, milestoneChoices } from "../lib/backing-records";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { useProjectTasks } from "../use-tasks";
import type { Place } from "./TradingOrderForms";

/** Whether the acting account may act as the founder: the account on the pool's record, or the project's own. */
export function isFounderAccount(
  me: string | null,
  founder: string,
  dao: string,
): boolean {
  if (me === null) return false;
  const who = me.toLowerCase();
  return (
    who === dao.toLowerCase() ||
    (/^0x0{40}$/.test(founder) ? false : who === founder.toLowerCase())
  );
}

/** "Open backing" for a project with no pool, or whose round did not reach its minimum. */
export function OpenBacking({
  view,
  target,
  me,
  place,
  blocked,
  busy,
  gateNoteId,
}: {
  view: NoPoolView | PoolView;
  target: { factory: string; dao: string };
  me: string | null;
  place: Place;
  blocked: boolean;
  busy: string | null;
  gateNoteId?: string;
}) {
  const base = useId();
  const field = useRef<HTMLInputElement>(null);
  const [how, setHow] = useState<"now" | "round" | null>(null);
  const [minimum, setMinimum] = useState("");
  const [tried, setTried] = useState(false);
  const rounds = view.kind === "none" ? view.round : { defaultMinimum: 0n };
  const allowed = isFounderAccount(me, view.founder, target.dao);
  if (!allowed && /^0x0{40}$/.test(view.founder)) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="backing-no-founder"
      >
        {NO_FOUNDER_LINE}
      </p>
    );
  }
  if (!allowed) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="backing-founder-account"
      >
        {FOUNDER_ACCOUNT_LINE}
      </p>
    );
  }
  const typed =
    minimum.trim() === "" ? null : parseAmount(minimum, view.quote.decimals);
  const problem =
    minimum.trim() !== "" && typed === null
      ? `Use a number with at most ${view.quote.decimals} decimals.`
      : null;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (how === null) return;
    if (how === "round" && problem !== null) {
      field.current?.focus();
      return;
    }
    // Empty asks the factory for its own default minimum.
    const placed = await place("backing-open", () =>
      openBackingCalls(
        target.factory,
        target.dao,
        how === "now"
          ? { kind: "now" }
          : { kind: "round", minimum: typed ?? 0n },
      ),
    );
    if (placed) setHow(null);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="backing-open-panel">
      <div className="flex flex-wrap gap-2">
        <Button
          aria-controls={`${base}-open`}
          aria-expanded={how === "now"}
          className="max-sm:h-11"
          data-testid="backing-open-now"
          onClick={() => setHow(how === "now" ? null : "now")}
          size="sm"
          type="button"
        >
          {OPEN_NOW_LABEL}
        </Button>
        {rounds ? (
          <Button
            aria-controls={`${base}-open`}
            aria-expanded={how === "round"}
            className="max-sm:h-11"
            data-testid="backing-open-round"
            onClick={() => setHow(how === "round" ? null : "round")}
            size="sm"
            type="button"
            variant="outline"
          >
            {OPEN_ROUND_LABEL}
          </Button>
        ) : null}
      </div>
      <div id={`${base}-open`}>
        {how ? (
          <form
            className="flex flex-col gap-2 rounded-lg border p-3"
            data-testid="backing-open-form"
            onSubmit={send}
          >
            <p className="text-sm">
              {how === "now" ? OPEN_NOW_HELP : OPEN_ROUND_HELP}
            </p>
            {how === "round" && rounds ? (
              <>
                <label className="text-sm font-medium" htmlFor={`${base}-min`}>
                  The least the round must raise
                  {view.quote.symbol ? ` (${view.quote.symbol})` : ""}
                </label>
                <Input
                  aria-describedby={`${base}-min-help`}
                  aria-invalid={tried && problem !== null}
                  autoComplete="off"
                  className="max-sm:h-11"
                  data-testid="backing-minimum"
                  id={`${base}-min`}
                  inputMode="decimal"
                  onChange={(event) => setMinimum(event.target.value)}
                  placeholder={
                    rounds.defaultMinimum > 0n
                      ? money(rounds.defaultMinimum, view.quote)
                      : ""
                  }
                  ref={field}
                  value={minimum}
                />
                <p
                  className="text-xs text-muted-foreground"
                  id={`${base}-min-help`}
                >
                  Leave it empty to ask for{" "}
                  {rounds.defaultMinimum > 0n
                    ? money(rounds.defaultMinimum, view.quote)
                    : "the usual minimum"}
                  , the most a round of this size can ask for. A round that
                  raises less opens nothing.
                </p>
                {tried && problem ? (
                  <p
                    className="text-sm text-destructive"
                    data-testid="backing-problem"
                  >
                    {problem}
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                aria-describedby={gateNoteId}
                className="max-sm:h-11"
                data-testid="backing-confirm-open"
                disabled={blocked}
                type="submit"
              >
                {busy === "backing-open"
                  ? "Opening…"
                  : how === "now"
                    ? OPEN_NOW_LABEL
                    : OPEN_ROUND_LABEL}
              </Button>
              <Button
                className="max-sm:h-11"
                onClick={() => setHow(null)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

/** "Post a milestone": pick one of the project's own records. */
export function PostMilestone({
  launch,
  view,
  place,
  blocked,
  busy,
  gateNoteId,
}: {
  launch: Launch;
  view: PoolView;
  place: Place;
  blocked: boolean;
  busy: string | null;
  gateNoteId?: string;
}) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [tried, setTried] = useState(false);
  const read = useProjectUpdates(launch.record);
  const tasks = useProjectTasks(launch.record);
  const choices = useMemo(() => {
    const own = read.data?.founder;
    if (!own) return null;
    return milestoneChoices({
      founder: launch.record.author,
      updates: own.updates,
      goals: own.goals,
      tasks: tasks.tasks,
      now: Math.floor(Date.now() / 1000),
    });
  }, [read.data, tasks.tasks, launch.record.author]);
  const select = useRef<HTMLSelectElement>(null);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (picked === "") {
      select.current?.focus();
      return;
    }
    const placed = await place("backing-post", () =>
      postMilestoneCalls(view.pool, picked),
    );
    if (placed) {
      setOpen(false);
      setPicked("");
      setTried(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="backing-post-panel">
      <div>
        <Button
          aria-controls={`${base}-form`}
          aria-expanded={open}
          className="max-sm:h-11"
          data-testid="backing-post"
          onClick={() => setOpen((was) => !was)}
          size="sm"
          type="button"
        >
          Post a milestone
        </Button>
      </div>
      <div id={`${base}-form`}>
        {open ? (
          <form
            className="flex flex-col gap-2 rounded-lg border p-3"
            data-testid="backing-post-form"
            onSubmit={send}
          >
            <p className="text-sm">{POST_MILESTONE_HELP}</p>
            {choices === null ? (
              <p className="text-sm text-muted-foreground" role="status">
                {read.isError
                  ? "Couldn't read the project's records, so none can be picked right now. Try again in a moment."
                  : "Reading the project's records…"}
              </p>
            ) : choices.length === 0 ? (
              <p className="text-sm" data-testid="backing-no-records">
                {NO_RECORDS_LINE}
              </p>
            ) : (
              <>
                <label
                  className="text-sm font-medium"
                  htmlFor={`${base}-record`}
                >
                  The record that shows it
                </label>
                <select
                  aria-invalid={tried && picked === ""}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm max-sm:h-11"
                  data-testid="backing-record"
                  id={`${base}-record`}
                  onChange={(event) => setPicked(event.target.value)}
                  ref={select}
                  value={picked}
                >
                  <option value="">Pick a record…</option>
                  {choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {KIND_WORD[choice.kind]}: {choice.label}
                    </option>
                  ))}
                </select>
                {tried && picked === "" ? (
                  <p
                    className="text-sm text-destructive"
                    data-testid="backing-problem"
                  >
                    Pick the record that shows this milestone.
                  </p>
                ) : null}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                aria-describedby={gateNoteId}
                className="max-sm:h-11"
                data-testid="backing-confirm-post"
                disabled={blocked || choices === null || choices.length === 0}
                type="submit"
              >
                {busy === "backing-post" ? "Posting…" : "Post this milestone"}
              </Button>
              <Button
                className="max-sm:h-11"
                onClick={() => setOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

/** The founder's line while no milestone can be posted yet. */
export function WaitLine({ from }: { from: number }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid="backing-wait">
      The next milestone can be posted from {whenWords(from)}.
    </p>
  );
}
