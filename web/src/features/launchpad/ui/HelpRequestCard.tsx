/**
 * The help an update asks for, as a card: what is needed, the size the founder picked, a rough time if they gave one,
 * and "I can help". An offer is a short public note the team is told about. It is not an agreement and the card never
 * names an amount: how work is rewarded is the project's own Work tab, which it links to when the project has one.
 *
 * The team sees who offered, can reply to each person, and can mark the request "Help found", which closes it to new
 * offers until they reopen it. Someone who offered sees their offer, the team's replies, and can take the offer back.
 *
 * Offers are read for this project on their own (`useProjectUpdates`). Until that read answers, and when it fails, the
 * card shows what was asked and says so: it never shows "no offers" or an open button for what it has not read.
 */

import { Link } from "@tanstack/react-router";
import { HandHelping } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import { agentLabel } from "../lib/agent-label";
import {
  HELP_NOTE_MAX,
  helpRequest,
  type Offer,
  teamOf,
  offerCountLine,
  offeredLine,
} from "../lib/help-request";
import { removalFailedLine, withReason } from "../lib/removals";
import { HELP_SIZE_LABEL } from "../lib/weekly-update";
import type { Launch, LaunchUpdate } from "../models";
import { MyOfferTask, OfferTask } from "./OfferTask";
import {
  OfferWithdrawnError,
  useHelpActions,
  useProjectUpdates,
} from "../use-help-requests";

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
  hint,
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
  /** Said under the label, before Send: what the person should know first. */
  hint?: string;
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
      onKeyDown={(e) => {
        // Escape puts the box away, as Cancel does. Not while a send is on its way: its result needs somewhere to land.
        if (e.key !== "Escape" || busy) return;
        e.stopPropagation();
        onCancel();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSend(note);
      }}
    >
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`${testId}-hint`}
          id={`${id}-hint`}
        >
          {hint}
        </p>
      ) : null}
      <textarea
        aria-describedby={hint ? `${id}-hint` : undefined}
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
  const team = useMemo(() => teamOf(record), [record]);
  const read = useProjectUpdates(record);
  const signals = read.data?.signals;
  const view = useMemo(
    () => helpRequest({ update, signals: signals ?? [], team, viewer: me }),
    [update, signals, team, me],
  );
  const actions = useHelpActions(record);
  const [offering, setOffering] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  /** Something that happened to what the person was doing, said once in the card. */
  const [notice, setNotice] = useState<string | null>(null);
  const people = view
    ? [
        ...view.offers.map((o) => o.author),
        // Whoever runs an agent that offered, to name them beside it.
        ...view.offers.flatMap((o) => (o.agent?.owner ? [o.agent.owner] : [])),
        ...view.foundBy,
        ...team,
      ]
    : [];
  const names = useUserNames(people);
  const headingId = useId();

  // Where the keyboard goes when a box closes: back to the button that opened it, or to what replaced that button.
  const section = useRef<HTMLElement | null>(null);
  const settling = read.isFetching;
  const [focusOn, setFocusOn] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: looked for again whenever the card's contents change
  useEffect(() => {
    if (!focusOn) return;
    const target = section.current?.querySelector<HTMLElement>(
      `[data-help-focus="${focusOn}"]`,
    );
    // Still being read again after a send: what takes the button's place is not drawn yet.
    if (!target && settling) return;
    // Nothing took its place (the request closed meanwhile): the card itself, so focus is not dropped on the page.
    (target ?? section.current)?.focus();
    setFocusOn(null);
  }, [focusOn, view, offering, replyingTo, settling]);

  // The offer being replied to was taken back while the box was open: say so instead of letting the box vanish.
  const known = signals !== undefined;
  const replyTargetGone =
    known &&
    replyingTo !== null &&
    !view?.offers.some((o) => o.id === replyingTo);
  useEffect(() => {
    if (!replyTargetGone) return;
    setReplyingTo(null);
    setNotice(
      "That offer was withdrawn while you were writing, so there is nothing to reply to.",
    );
  }, [replyTargetGone]);

  if (!view) return null;

  const { ask, mine } = view;
  const count = known ? offerCountLine(view.offerCount) : null;
  const now = Math.floor(Date.now() / 1000);

  const sendOffer = (note: string) =>
    actions.offer.mutate(
      { updateId: update.id, updateAuthor: update.author, note },
      {
        onSuccess: () => {
          setOffering(false);
          setFocusOn("mine");
        },
      },
    );
  const startOffer = () => {
    // Signed out: the account dialog, then the person can come back to the same button.
    if (!me) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    actions.offer.reset();
    setNotice(null);
    setOffering(true);
  };
  const withdraw = () => {
    if (view.myOfferIds.length > 0)
      actions.withdraw.mutate(
        { offerIds: view.myOfferIds },
        { onSuccess: () => setFocusOn("offer") },
      );
  };
  const markFound = () =>
    actions.found.mutate(
      { updateId: update.id },
      { onSuccess: () => setFocusOn("reopen") },
    );
  const reopen = () =>
    actions.reopen.mutate(
      { foundIds: view.myFoundIds },
      { onSuccess: () => setFocusOn("found") },
    );
  const sendReply = (offer: Offer, note: string) => {
    if (note.trim() === "") return;
    actions.reply.mutate(
      { offerId: offer.id, offerAuthor: offer.author, note },
      {
        onSuccess: () => {
          setReplyingTo(null);
          setFocusOn(`reply-${offer.id}`);
        },
        onError: (error) => {
          if (!(error instanceof OfferWithdrawnError)) return;
          setReplyingTo(null);
          setNotice(
            `${names(offer.author)} withdrew their offer, so your reply was not sent.`,
          );
        },
      },
    );
  };
  const othersFound = view.foundBy.filter((who) => who !== me);

  return (
    <section
      aria-busy={read.isLoading || undefined}
      aria-labelledby={headingId}
      className="mt-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-open={known ? (view.open ? "true" : "false") : undefined}
      data-testid="help-request"
      ref={section}
      tabIndex={-1}
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
        {known && !view.open ? (
          <Chip data-testid="help-found" tone="success">
            Help found
          </Chip>
        ) : null}
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
      {known && read.data && !read.data.complete ? (
        <p className="mt-2 text-xs text-muted-foreground" role="note">
          This project has more records than could be read here, so some offers
          may be missing.
        </p>
      ) : null}
      {notice ? (
        <p className="mt-2 text-sm" data-testid="help-notice" role="status">
          {notice}
        </p>
      ) : null}

      {!known ? (
        read.isError ? (
          <SendFailed
            onRetry={() => void read.refetch()}
            testId="help-read-failed"
          >
            Couldn't check the offers on this request.
          </SendFailed>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Checking the offers…
          </p>
        )
      ) : view.viewerOnTeam ? (
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
                    {offer.agent ? (
                      <>
                        <Chip data-testid="help-offer-agent" tone="info">
                          {agentLabel(
                            offer.agent.owner ? names(offer.agent.owner) : null,
                          )}
                        </Chip>{" "}
                      </>
                    ) : null}
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
                  <OfferTask
                    ask={ask}
                    helperName={names(offer.author)}
                    launch={launch}
                    offer={offer}
                    updateId={update.id}
                  />
                  {replyingTo === offer.id ? (
                    <NoteBox
                      busy={actions.reply.isPending}
                      failed={
                        actions.reply.isError
                          ? withReason(
                              "Your reply was not sent.",
                              actions.reply.error,
                            )
                          : null
                      }
                      hint="Your reply is public: anyone can read it."
                      label={`Reply to ${names(offer.author)}`}
                      onCancel={() => {
                        setReplyingTo(null);
                        setFocusOn(`reply-${offer.id}`);
                      }}
                      onSend={(note) => sendReply(offer, note)}
                      placeholder="Say thanks and how to get started."
                      send="Send reply"
                      sending="Sending…"
                      testId="help-reply-box"
                    />
                  ) : (
                    <Button
                      aria-label={`Reply to ${names(offer.author)}`}
                      className="mt-1"
                      data-help-focus={`reply-${offer.id}`}
                      onClick={() => {
                        actions.reply.reset();
                        setNotice(null);
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
                data-help-focus="found"
                disabled={actions.found.isPending}
                onClick={markFound}
                size="sm"
                type="button"
                variant="outline"
              >
                {actions.found.isPending ? "Saving…" : "Mark as Help found"}
              </Button>
              <span className="ml-2 text-xs text-muted-foreground">
                Closes the request to new offers. You can reopen it.
              </span>
              {actions.found.isError ? (
                <SendFailed onRetry={markFound} testId="help-found-failed">
                  {withReason(
                    "The request was not closed.",
                    actions.found.error,
                  )}
                </SendFailed>
              ) : null}
            </div>
          ) : (
            <div className="mt-2" data-testid="help-closed">
              {othersFound.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Marked found by {othersFound.map(names).join(", ")}. It stays
                  closed until they reopen it too.
                </p>
              ) : null}
              {view.myFoundIds.length > 0 ? (
                <Button
                  className="mt-1"
                  data-help-focus="reopen"
                  disabled={actions.reopen.isPending}
                  onClick={reopen}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {actions.reopen.isPending ? "Reopening…" : "Reopen"}
                </Button>
              ) : null}
              {actions.reopen.isError ? (
                <SendFailed onRetry={reopen} testId="help-reopen-failed">
                  {removalFailedLine(
                    actions.reopen.error,
                    "The request was not reopened.",
                  )}
                </SendFailed>
              ) : null}
            </div>
          )}
        </>
      ) : mine ? (
        <div className="mt-2" data-testid="help-my-offer">
          <p
            className="text-sm font-medium outline-none"
            data-help-focus="mine"
            role="status"
            tabIndex={-1}
          >
            {offeredLine(mine.at, now)}
          </p>
          {mine.note ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {mine.note}
            </p>
          ) : null}
          <Replies names={names} offer={mine} />
          {me ? (
            <MyOfferTask launch={launch} me={me} offerId={mine.id} />
          ) : null}
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
              {removalFailedLine(
                actions.withdraw.error,
                "Your offer was not withdrawn.",
              )}
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
          failed={
            actions.offer.isError
              ? withReason("Your offer was not sent.", actions.offer.error)
              : null
          }
          hint="Your offer and your note are public: anyone can read them."
          label="Add a short note (optional)"
          onCancel={() => {
            setOffering(false);
            setFocusOn("offer");
          }}
          onSend={sendOffer}
          placeholder="What you can do, in a sentence or two."
          send="Send offer"
          sending="Sending…"
          testId="help-offer-box"
        />
      ) : (
        <div className="mt-2">
          <Button
            data-help-focus="offer"
            onClick={startOffer}
            size="sm"
            type="button"
          >
            I can help
          </Button>
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="help-no-promise"
          >
            The team sees your offer and can reply. Offering help is not an
            agreement or a promise of reward.
          </p>
        </div>
      )}

      {workTab ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="help-work-link"
        >
          Rewards are decided separately, by the project's own rules.{" "}
          <Link
            className="text-foreground underline"
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
