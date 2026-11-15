/**
 * A project's public record, read only, for someone the server does not let in: the goal, how the weekly updates and
 * promises stand, the last promises answered, the latest update and the work that was accepted. One line says that
 * taking part needs an invite; Sign in is offered to someone who has not signed in on this browser.
 *
 * Everything here is from records the project's own people signed, as the server chose to show them
 * (`lib/public-record.ts`). There is nothing to press but Sign in: following, helping and posting are for members, so
 * they are not shown. There is no price here.
 */

import type { ReactNode } from "react";

import { ProjectMark } from "@/features/feed/ui/MovingNow";
import { SIGN_IN_EVENT } from "@/features/identity/lib/account-copy";
import { APP_NAME } from "@/shared/constants/brand";
import { usePageMeta } from "@/shared/lib/page-meta";
import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import { PROMISE_STATE_LABEL, type PromiseState } from "../lib/promises";
import type { PublicRecordView } from "../lib/public-record";
import { ASK_FOR_INVITE_TEXT, PUBLIC_RECORD_TEXT } from "../lib/refusal-copy";
import { freshnessLine } from "../lib/weekly-update";

const TONE: Partial<Record<PromiseState, ChipTone>> = {
  kept: "success",
  missed: "danger",
  changed: "warning",
};

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function Fact({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId: string;
}) {
  return (
    <div className="glass flex min-w-0 flex-col rounded-2xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-base font-bold" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function PublicRecord({
  view,
  signedIn,
}: {
  view: PublicRecordView;
  /** This browser has an account (which the server has not let in). */
  signedIn: boolean;
}) {
  const now = Math.floor(Date.now() / 1000);
  const totals = view.promises;
  const answered = totals ? totals.kept + totals.missed + totals.changed : null;
  usePageMeta({
    title: `${view.name} on ${APP_NAME}`,
    description: view.goal.slice(0, 200),
  });

  return (
    <article className="flex w-full flex-col gap-5" data-testid="public-record">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <ProjectMark image={view.image} name={view.name} />
          <h1 className="min-w-0 break-words text-2xl font-black">
            {view.name}
          </h1>
        </div>
        {view.goal ? (
          <p className="break-words text-base" data-testid="public-record-goal">
            {view.goal}
          </p>
        ) : null}
        {view.goalHow ? (
          <p className="break-words text-sm text-muted-foreground">
            How we will know: {view.goalHow}
          </p>
        ) : null}
        <div
          className="glass flex flex-col items-start gap-2 rounded-2xl border p-3 text-sm"
          data-testid="public-record-invite"
        >
          <p>
            {PUBLIC_RECORD_TEXT} {ASK_FOR_INVITE_TEXT}
          </p>
          {signedIn ? null : (
            <Button
              className="max-sm:h-11"
              data-testid="public-record-sign-in"
              onClick={() => window.dispatchEvent(new Event(SIGN_IN_EVENT))}
              size="sm"
              type="button"
            >
              Sign in
            </Button>
          )}
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact
          label="Weekly updates"
          testId="public-record-streak"
          value={
            view.streak === null
              ? "Not known"
              : view.streak >= 2
                ? `${view.streak} weeks in a row`
                : view.streak === 1
                  ? "1 week so far"
                  : "No run yet"
          }
        />
        <Fact
          label="Promises kept"
          testId="public-record-kept"
          value={
            totals === null
              ? "Not known"
              : answered
                ? `${totals.kept} of ${answered}`
                : "None answered yet"
          }
        />
        <Fact
          label="Not kept"
          testId="public-record-missed"
          value={
            totals === null ? (
              "Not known"
            ) : (
              <>
                <span className="block">{totals.missed} missed</span>
                <span className="block">{totals.changed} changed</span>
              </>
            )
          }
        />
        <Fact
          label="Work accepted"
          testId="public-record-accepted"
          value={
            view.accepted === null
              ? "Not known"
              : view.accepted === 0
                ? "None yet"
                : view.accepted === 1
                  ? "1 piece"
                  : `${view.accepted} pieces`
          }
        />
      </dl>
      {view.complete ? null : (
        <p
          className="text-xs"
          data-testid="public-record-partial"
          role="status"
        >
          Not all of this project's records could be read here, so a number that
          could not be worked out says "Not known".
        </p>
      )}

      <section
        aria-labelledby="public-record-promises-heading"
        className="flex flex-col gap-2"
      >
        <h2
          className="text-base font-semibold"
          id="public-record-promises-heading"
        >
          Last promises answered
        </h2>
        {view.answered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No promise has been answered yet. Each weekly update says what is
            next, and the one after says what came of it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.answered.map((promise) => (
              <li
                className="glass flex flex-wrap items-baseline gap-2 rounded-2xl border p-3 text-sm"
                data-state={promise.state}
                data-testid="public-record-promise"
                key={promise.id}
              >
                <Chip tone={TONE[promise.state] ?? "neutral"}>
                  {PROMISE_STATE_LABEL[promise.state]}
                </Chip>
                <span className="min-w-0 flex-1 break-words">
                  {promise.text}
                  {promise.note ? (
                    <span className="block text-xs text-muted-foreground">
                      {promise.note}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="public-record-update-heading"
        className="flex flex-col gap-2"
      >
        <h2
          className="text-base font-semibold"
          id="public-record-update-heading"
        >
          Latest update
        </h2>
        {view.latest ? (
          <div
            className="glass rounded-2xl border p-3"
            data-testid="public-record-update"
          >
            <p className="text-xs text-muted-foreground">
              {freshnessLine(view.latest.at, now)}
            </p>
            <h3 className="mt-1 break-words text-sm font-bold">
              {view.latest.title}
            </h3>
            {view.latest.body ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {view.latest.body}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No update yet.</p>
        )}
      </section>

      {view.work.length > 0 ? (
        <section
          aria-labelledby="public-record-work-heading"
          className="flex flex-col gap-2"
        >
          <h2
            className="text-base font-semibold"
            id="public-record-work-heading"
          >
            Work accepted
          </h2>
          <ul className="flex flex-col gap-2">
            {view.work.map((piece) => (
              <li
                className="glass rounded-2xl border p-3 text-sm"
                data-testid="public-record-work"
                key={piece.id}
              >
                <span className="block break-words">{piece.what}</span>
                <span className="block text-xs text-muted-foreground">
                  Accepted {day(piece.acceptedAt)}, checked by someone other
                  than the person who did it.
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
