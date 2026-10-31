import { Gauge } from "lucide-react";
import { useId, useState } from "react";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Input } from "@/shared/ui/input";
import { Meter } from "@/shared/ui/meter";
import {
  countingForecasts,
  MAX_REASON,
  middleForecast,
  type QuestionState,
} from "@creaton/core/launchpad/forecast.ts";
import { useForecasts } from "../use-forecasts";
import { usePeopleWithWallets } from "../use-people";
import { Person } from "./Face";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const MOST_SHOWN = 5;

/**
 * "Will it get done?" (N3): people's percents that a bounty will be paid, each with a reason, and the middle of them.
 * No money, no extra votes, no say in who is chosen. Forecasts close at the question's cutoff; each person's latest
 * before it counts. People involved in the bounty (who opened it, submitted work, or review it) are marked.
 */
export function ForecastPanel({
  question,
  state,
  now,
  involved,
}: {
  question: string;
  state: QuestionState;
  /** The chain's own time. */
  now: number;
  /** The wallets of the people involved; their forecasts are marked. */
  involved: readonly string[];
}) {
  const id = useId();
  const { query, publish } = useForecasts(question);
  const people = usePeopleWithWallets();
  const all = query.data ?? [];
  const counted = countingForecasts(all, state.cutoff);
  const profiles = useProfiles(counted.map((f) => f.author));
  const me = existingUserPubkey();
  const mine = me ? counted.find((f) => f.author === me) : undefined;
  const [percentText, setPercentText] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const involvedSet = new Set(involved.map((a) => a.toLowerCase()));
  const walletOf = new Map(
    (people.data ?? []).map((p) => [p.pubkey, p.address.toLowerCase()]),
  );
  const isInvolved = (pubkey: string) =>
    involvedSet.has(walletOf.get(pubkey) ?? "");
  const nameOf = (pubkey: string) =>
    resolveUserName(profiles.data?.[pubkey], pubkey);
  const middle = middleForecast(counted);
  const open = now < state.cutoff && state.outcome === null;
  const send = async () => {
    setProblem(null);
    const percent = Number(percentText.trim());
    if (!/^\d{1,3}$/.test(percentText.trim()) || percent > 100) {
      setProblem("Give a whole percent from 0 to 100.");
      return;
    }
    setSending(true);
    try {
      await publish(percent, reason);
      setPercentText("");
      setReason("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };
  const shown = showAll ? counted : counted.slice(0, MOST_SHOWN);
  return (
    <div
      className="mt-2 rounded-xl bg-secondary/60 p-3 text-sm"
      data-testid="forecast-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Gauge aria-hidden className="h-3.5 w-3.5" />
          Will it get done?
        </p>
        <p
          className="text-xs text-muted-foreground"
          data-testid="forecast-summary"
        >
          {query.isError ? (
            <>
              Forecasts could not be read.{" "}
              <button
                className="underline"
                onClick={() => void query.refetch()}
                type="button"
              >
                Try again
              </button>
            </>
          ) : query.data === undefined ? (
            "Reading forecasts…"
          ) : middle === null ? (
            "No forecasts yet."
          ) : (
            `Middle forecast: ${middle}% · ${counted.length === 1 ? "1 person" : `${counted.length} people`}`
          )}
        </p>
      </div>
      {middle !== null ? (
        <Meter
          className="mt-2"
          label="Middle forecast"
          max={100n}
          tone="info"
          value={BigInt(middle)}
        />
      ) : null}
      {state.outcome !== null && middle !== null ? (
        <p
          className={
            state.outcome === "done"
              ? "mt-2 flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300"
              : "mt-2 flex items-center gap-1.5 text-amber-800 dark:text-amber-300"
          }
          data-testid="forecast-outcome"
        >
          {state.outcome === "done"
            ? `It got done. The middle forecast was ${middle}%.`
            : `It was not done in time. The middle forecast was ${middle}%.`}
        </p>
      ) : !open ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="forecast-closed"
        >
          Forecasts closed on {date(state.cutoff)}.
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2" data-testid="forecast-list">
          {shown.map((f) => (
            <li className="text-xs" data-testid="forecast-item" key={f.id}>
              <span className="flex flex-wrap items-center gap-1.5">
                <Person label={nameOf(f.author)} />
                <Chip tone="info">{f.percent}%</Chip>
                {isInvolved(f.author) ? (
                  <Chip data-testid="forecast-involved">Involved</Chip>
                ) : null}
              </span>
              <span className="mt-0.5 block pl-7 text-muted-foreground">
                {f.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {counted.length > MOST_SHOWN ? (
        <button
          className="mt-1 text-xs underline"
          onClick={() => setShowAll((v) => !v)}
          type="button"
        >
          {showAll ? "Show fewer" : `Show all ${counted.length}`}
        </button>
      ) : null}
      {open && me ? (
        <div className="mt-3 flex flex-col gap-2" data-testid="forecast-form">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor={`${id}-percent`}>
                {mine ? `Yours: ${mine.percent}%` : "Your %"}
              </label>
              <Input
                className="w-20"
                data-testid="forecast-percent"
                id={`${id}-percent`}
                inputMode="numeric"
                onChange={(e) => setPercentText(e.target.value)}
                placeholder="60"
                value={percentText}
              />
            </div>
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <label className="text-xs font-medium" htmlFor={`${id}-reason`}>
                Why
              </label>
              <Input
                data-testid="forecast-reason"
                id={`${id}-reason`}
                maxLength={MAX_REASON}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What makes you think so"
                value={reason}
              />
            </div>
            <Button
              data-testid="forecast-submit"
              disabled={sending}
              onClick={() => void send()}
              size="sm"
              type="button"
              variant="outline"
            >
              {sending ? "Publishing…" : mine ? "Change it" : "Publish"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Public, with your name. No money, no vote. Closes{" "}
            {date(state.cutoff)}.
          </p>
          {problem ? (
            <p className="text-xs text-red-700 dark:text-red-300" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : open ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Make an account to give a forecast.
        </p>
      ) : null}
    </div>
  );
}
