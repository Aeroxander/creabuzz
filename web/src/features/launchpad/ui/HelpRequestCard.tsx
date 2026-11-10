/**
 * The help an update asks for, as a card: what is needed, the size the founder picked, a rough time if they gave one,
 * and "I can help". An offer is a short public note the team is told about. It is not an agreement and the card never
 * names an amount: how work is rewarded is the project's own Work tab, which it links to when the project has one.
 *
 * The team sees who offered, can reply to each person, and can mark the request "Help found", which closes it to new
 * offers. Someone who offered sees their offer, the team's replies, and can take the offer back.
 */

import { Link } from "@tanstack/react-router";
import { HandHelping } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import {
  HELP_NOTE_MAX,
  helpRequest,
  type Offer,
  offerCountLine,
  offeredLine,
} from "../lib/help-request";
import { HELP_SIZE_LABEL } from "../lib/weekly-update";
import type { Launch, LaunchUpdate } from "../models";
import { useHelpActions } from "../use-help-requests";

const NOTE_CLASS =
  "mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white";

/** A send that did not go through: said where it happened, with a way to send it again. */
function SendFailed({
  children,
  onRetry,
  testId,
}: {
  children: ReactNode;
  onRetry: () => void;
  testId: string;
}) {
  return (
    <p
      className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-300"
      data-testid={testId}
      role="alert"
    >
      <span>{children}</span>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        Try again
      </Button>
    </p>
  );
}

/** A short optional note with Send and Cancel: the offer box, and the team's reply box. */
function NoteBox({
  label,
  placeholder,
  send,
  sending,
  busy,
  failed,
  onSend,
  onCancel,
  testId,
}: {
  label: string;
  placeholder: string;
  send: string;
  sending: string;
  busy: boolean;
  /** What to say when the last send failed, or null. */
  failed: string | null;
  onSend: (note: string) => void;
  onCancel: () => void;
  testId: string;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  return (
    <form
      className="mt-2"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSend(note);
      }}
    >
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the box opens because the person asked for it; typing starts in it
        autoFocus
        className={NOTE_CLASS}
        id={id}
        maxLength={HELP_NOTE_MAX}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        rows={2}
        value={note}
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button disabled={busy} size="sm" type="submit">
          {busy ? sending : send}
        </Button>
        <Button
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
      {failed ? (
        <SendFailed onRetry={() => onSend(note)} testId={`${testId}-failed`}>
          {failed}
        </SendFailed>
      ) : null}
    </form>
  );
}

function PersonLink({ pubkey, name }: { pubkey: string; name: string }) {
  return (
    <Link
      className="font-semibold text-foreground underline"
      params={{ pubkey }}
      to="/u/$pubkey"
    >
      {name}
    </Link>
  );
}

function Replies({
  offer,
  names,
}: {
  offer: Offer;
  names: (pubkey: string) => string;
}) {
  if (offer.replies.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 border-l-2 border-border pl-3">
      {offer.replies.map((reply) => (
        <li
          className="break-words text-sm"
          data-testid="help-reply"
          key={reply.id}
        >
          <span className="text-xs text-muted-foreground">
            {names(reply.author)} replied {relativeTime(reply.at)}
          </span>
          <span className="block whitespace-pre-wrap">{reply.note}</span>
        </li>
      ))}
    </ul>
  );
}

export function HelpRequestCard({
  launch,
  update,
  workTab,
}: {
  launch: Launch;
  update: LaunchUpdate;
  /** Whether this project has a Work tab to point at. */
  workTab: boolean;
}) {
  const me = existingUserPubkey();
  const { record } = launch;
  const team = useMemo(
    () => new Set([record.author, ...record.team.map((m) => m.pubkey)]),
    [record.author, record.team],
  );
  const view = useMemo(
    () =>
      helpRequest({
        update,
        signals: launch.helpSignals ?? [],
        team,
        viewer: me,
      }),
    [update, launch.helpSignals, team, me],
  );
  const actions = useHelpActions(record);
  const [offering, setOffering] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const people = view
    ? [...view.offers.flatMap((o) => [o.author]), ...team]
    : [];
  const names = useUserNames(people);
  const headingId = useId();
  if (!view) return null;

  const { ask, mine } = view;
  const count = offerCountLine(view.offerCount);
  const now = Math.floor(Date.now() / 1000);

  const sendOffer = (note: string) =>
    actions.offer.mutate(
      { updateId: update.id, updateAuthor: update.author, note },
      { onSuccess: () => setOffering(false) },
    );
  const startOffer = () => {
    // Signed out: the account dialog, then the person can come back to the same button.
    if (!me) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    actions.offer.reset();
    setOffering(true);
  };
  const withdraw = () => {
    if (mine) actions.withdraw.mutate({ offerId: mine.id });
  };
  const markFound = () => actions.found.mutate({ updateId: update.id });

  return (
    <section
      aria-labelledby={headingId}
      className="mt-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3"
      data-open={view.open ? "true" : "false"}
      data-testid="help-request"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4
          className="flex items-center gap-1.5 text-sm font-bold"
          id={headingId}
        >
          <HandHelping aria-hidden className="h-4 w-4" />
          Help needed
        </h4>
        <Chip data-testid="help-size">{HELP_SIZE_LABEL[ask.size]}</Chip>
        {ask.time ? <Chip data-testid="help-time">{ask.time}</Chip> : null}
        {view.open ? null : (
          <Chip data-testid="help-found" tone="success">
            Help found
          </Chip>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{ask.text}</p>
      {count ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="help-offer-count"
        >
          {count}
        </p>
      ) : null}

      {view.viewerOnTeam ? (
        <>
          {view.offers.length > 0 ? (
            <ul className="mt-2 space-y-2" data-testid="help-offers">
              {view.offers.map((offer) => (
                <li
                  className="rounded-lg border border-border bg-background/70 p-2"
                  data-testid="help-offer"
                  key={offer.id}
                >
                  <p className="break-words text-sm">
                    <PersonLink
                      name={names(offer.author)}
                      pubkey={offer.author}
                    />{" "}
                    <span className="text-xs text-muted-foreground">
                      offered to help {relativeTime(offer.at)}
                    </span>
                  </p>
                  {offer.note ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {offer.note}
                    </p>
                  ) : null}
                  <Replies names={names} offer={offer} />
                  {replyingTo === offer.id ? (
                    <NoteBox
                      busy={actions.reply.isPending}
                      failed={
                        actions.reply.isError
                          ? "Your reply was not sent."
                          : null
                      }
                      label={`Reply to ${names(offer.author)}`}
                      onCancel={() => setReplyingTo(null)}
                      onSend={(note) => {
                        if (note.trim() === "") return;
                        actions.reply.mutate(
                          {
                            offerId: offer.id,
                            offerAuthor: offer.author,
                            note,
                          },
                          { onSuccess: () => setReplyingTo(null) },
                        );
                      }}
                      placeholder="Say thanks and how to get started."
                      send="Send reply"
                      sending="Sending…"
                      testId="help-reply-box"
                    />
                  ) : (
                    <Button
                      className="mt-1"
                      onClick={() => {
                        actions.reply.reset();
                        setReplyingTo(offer.id);
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Reply
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : view.open ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No offers yet. People who follow the project see this request.
            </p>
          ) : null}
          {view.offerCount > view.offers.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing the newest {view.offers.length} offers.
            </p>
          ) : null}
          {view.open ? (
            <div className="mt-2">
              <Button
                disabled={actions.found.isPending}
                onClick={markFound}
                size="sm"
                type="button"
                variant="outline"
              >
                {actions.found.isPending ? "Saving…" : "Mark as Help found"}
              </Button>
              {actions.found.isError ? (
                <SendFailed onRetry={markFound} testId="help-found-failed">
                  The request was not closed.
                </SendFailed>
              ) : null}
            </div>
          ) : null}
        </>
      ) : mine ? (
        <div className="mt-2" data-testid="help-my-offer">
          <p className="text-sm font-medium" role="status">
            {offeredLine(mine.at, now)}
          </p>
          {mine.note ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {mine.note}
            </p>
          ) : null}
          <Replies names={names} offer={mine} />
          <Button
            className="mt-2"
            disabled={actions.withdraw.isPending}
            onClick={withdraw}
            size="sm"
            type="button"
            variant="outline"
          >
            {actions.withdraw.isPending ? "Withdrawing…" : "Withdraw offer"}
          </Button>
          {actions.withdraw.isError ? (
            <SendFailed onRetry={withdraw} testId="help-withdraw-failed">
              Your offer was not withdrawn.
            </SendFailed>
          ) : null}
        </div>
      ) : !view.open ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This request is closed.
        </p>
      ) : offering ? (
        <NoteBox
          busy={actions.offer.isPending}
          failed={actions.offer.isError ? "Your offer was not sent." : null}
          label="Add a short note (optional)"
          onCancel={() => setOffering(false)}
          onSend={sendOffer}
          placeholder="What you can do, in a sentence or two."
          send="Send offer"
          sending="Sending…"
          testId="help-offer-box"
        />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onClick={startOffer} size="sm" type="button">
            I can help
          </Button>
          <span className="text-xs text-muted-foreground">
            The team sees your offer and can reply.
          </span>
        </div>
      )}

      {workTab ? (
        <p className="mt-2 text-xs">
          <Link
            className="underline"
            params={{ launchId: record.id }}
            search={{ author: record.author, tab: "work" }}
            to="/launchpad/$launchId"
          >
            See how work is rewarded in this project
          </Link>
        </p>
      ) : null}
    </section>
  );
}
