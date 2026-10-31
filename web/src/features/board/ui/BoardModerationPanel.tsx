/**
 * Who moderates this board and what they have done: the appointed moderators with the end of their term, and the
 * board's public moderation log in plain words, each thread named and one tap away. Everyone sees both. Above them, for
 * the board's moderators only, the open reports about its posts and replies. The board's
 * owners and admins appoint (from the people on the board, after a confirmation naming them, or by profile link or key)
 * and remove moderators (after a confirmation naming them); a moderator can step
 * down. Moderators can lift a mute that is still in force, when they stand at least as high as whoever set it, and
 * confirm another moderator's request for a longer mute. The server decides each of these and its reason is shown
 * when it refuses.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Modal } from "@/features/launchpad/ui/Modal";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";

import {
  activeMutes,
  appointSuggestions,
  type BoardState,
  type LogEntry,
  logSentence,
  MODERATOR_TERM_DAYS,
  pendingLongerMutes,
} from "../lib/board-moderation";
import { parsePersonOrLink } from "../lib/person-link";
import type { BoardModerationActions } from "../use-board-moderation";
import type { BoardReports } from "../use-board-reports";
import { AuthorChip } from "./AuthorChip";
import { BoardReportsSection } from "./BoardReports";

function dateWords(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Appointing someone from the buttons is one tap: this asks first, naming them. */
function AppointDialog({
  name,
  onConfirm,
  onClose,
}: {
  name: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const title = `Make ${name} a moderator of this board?`;
  return (
    <Modal label={title} onClose={onClose}>
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        For {MODERATOR_TERM_DAYS} days they can lock, pin and remove posts and
        mute people on this board. It goes in the board's moderation log, and
        you can remove them as a moderator at any time.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          data-testid="board-appoint-confirm"
          onClick={onConfirm}
          size="sm"
          type="button"
        >
          Appoint {name}
        </Button>
      </div>
    </Modal>
  );
}

export function BoardModerationPanel({
  state,
  log,
  me,
  canModerate,
  canManage,
  actions,
  mayUndoBy,
  titleOf,
  onOpenPost,
  candidates,
  reports,
}: {
  state: BoardState;
  log: LogEntry[];
  me: string | null;
  canModerate: boolean;
  canManage: boolean;
  actions: BoardModerationActions;
  /** May the reader undo what this person did? */
  mayUndoBy: (placer: string | undefined) => boolean;
  /** A post's title, when the board has it. */
  titleOf: (post: string) => string | null;
  onOpenPost: (id: string) => void;
  /** People the reader could appoint, below moderator. */
  candidates: string[];
  /** Open reports about the board, shown to a reader who moderates it. */
  reports: BoardReports;
}) {
  const now = Math.floor(Date.now() / 1000);
  const moderators = [...state.moderators].filter(([, until]) => until > now);
  const mutes = activeMutes(log, now);
  const pending = new Set(pendingLongerMutes(log, now).map((e) => e.id));
  const shownCandidates = appointSuggestions(candidates, {
    reported: reports.rows.flatMap((row) =>
      row.words ? [row.words.author] : [],
    ),
    muted: mutes.keys(),
  });
  const people = [
    ...new Set([
      ...moderators.map(([pubkey]) => pubkey),
      ...shownCandidates,
      ...log.flatMap((entry) =>
        entry.person ? [entry.actor, entry.person] : [entry.actor],
      ),
      ...(canModerate
        ? reports.rows.flatMap((row) => (row.words ? [row.words.author] : []))
        : []),
    ]),
  ];
  const profiles = useProfiles(people).data;
  const nameOf = (pubkey: string) =>
    pubkey === me ? "you" : resolveUserName(profiles?.[pubkey], pubkey);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      toast.success(done);
      return true;
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "That did not go through. Try again.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const appoint = async () => {
    const pubkey = parsePersonOrLink(text);
    if (pubkey === null) {
      setProblem("Paste their profile link.");
      return;
    }
    if (await run(() => actions.appoint(pubkey), "Moderator appointed."))
      setText("");
  };

  return (
    <section
      aria-label="Moderation"
      className="flex flex-col gap-4 border-b px-4 py-3"
      data-testid="board-moderation-panel"
    >
      {canModerate ? (
        <BoardReportsSection
          nameOf={nameOf}
          onOpenPost={onOpenPost}
          reports={reports}
        />
      ) : null}
      <div>
        <h3 className="text-sm font-semibold">Moderators</h3>
        <p className="text-xs text-muted-foreground">
          They lock, pin and remove posts and mute people on this board.
        </p>
        <details className="text-xs text-muted-foreground">
          <summary
            className="w-fit cursor-pointer underline"
            data-testid="board-moderator-limits"
          >
            Limits
          </summary>
          <ul className="mt-1 list-disc pl-4">
            <li>
              Appointed by the board's owners and admins, for up to{" "}
              {MODERATOR_TERM_DAYS} days.
            </li>
            <li>Never act against each other or the owners and admins.</li>
            <li>At most 20 actions an hour each.</li>
          </ul>
        </details>
        {moderators.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No appointed moderators. The board's owners and admins moderate it.
          </p>
        ) : (
          <ul
            className="mt-2 flex flex-col gap-1.5"
            data-testid="board-moderators"
          >
            {moderators.map(([pubkey, until]) => (
              <li
                className="flex flex-wrap items-center gap-2 text-sm"
                key={pubkey}
              >
                {/* Your own row says so, as the log does ("you"). */}
                {pubkey === me ? (
                  <span
                    className="font-medium"
                    data-testid="board-moderator-you"
                  >
                    You
                  </span>
                ) : (
                  <AuthorChip profile={profiles?.[pubkey]} pubkey={pubkey} />
                )}
                <span className="text-xs text-muted-foreground">
                  until {dateWords(until)}
                </span>
                {pubkey === me ? (
                  <button
                    className="text-xs underline disabled:opacity-50"
                    data-testid="board-moderator-step-down"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => actions.dismiss(pubkey),
                        "You are no longer a moderator of this board.",
                      )
                    }
                    type="button"
                  >
                    Step down
                  </button>
                ) : canManage ? (
                  <button
                    className="text-xs underline disabled:opacity-50"
                    data-testid="board-moderator-dismiss"
                    disabled={busy}
                    onClick={() => setRemoving(pubkey)}
                    type="button"
                  >
                    Remove as moderator…
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <form
            className="mt-2 flex flex-wrap gap-2"
            data-testid="board-appoint-form"
            onSubmit={(event) => {
              event.preventDefault();
              void appoint();
            }}
          >
            <label className="sr-only" htmlFor="board-appoint-person">
              Person to appoint
            </label>
            <Input
              className="h-8 max-w-sm text-xs"
              data-testid="board-appoint-person"
              disabled={busy}
              id="board-appoint-person"
              onChange={(event) => setText(event.target.value)}
              placeholder="Their profile link"
              value={text}
            />
            <Button
              data-testid="board-appoint-submit"
              disabled={busy || text.trim() === ""}
              size="sm"
              type="submit"
            >
              Appoint for {MODERATOR_TERM_DAYS} days
            </Button>
          </form>
        ) : null}
        {canManage && shownCandidates.length > 0 ? (
          <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            People on this board:
            {shownCandidates.map((pubkey) => (
              <button
                className="rounded-full border px-2 py-0.5 hover:bg-secondary disabled:opacity-50"
                data-testid="board-appoint-candidate"
                disabled={busy}
                key={pubkey}
                onClick={() => setConfirming(pubkey)}
                type="button"
              >
                Appoint {nameOf(pubkey)}
              </button>
            ))}
          </p>
        ) : null}
        {confirming !== null ? (
          <AppointDialog
            name={nameOf(confirming)}
            onClose={() => setConfirming(null)}
            onConfirm={() => {
              const pubkey = confirming;
              setConfirming(null);
              void run(() => actions.appoint(pubkey), "Moderator appointed.");
            }}
          />
        ) : null}
        <ConfirmDialog
          confirmLabel="Remove as moderator"
          description={`${removing === null ? "They" : nameOf(removing)} can no longer lock, pin or remove posts or mute people on this board. It goes in the board's moderation log.`}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const pubkey = removing;
            setRemoving(null);
            if (pubkey !== null)
              void run(
                () => actions.dismiss(pubkey),
                "No longer a moderator of this board.",
              );
          }}
          open={removing !== null}
          title={`Remove ${removing === null ? "them" : nameOf(removing)} as a moderator?`}
        />
        {problem ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
      </div>

      <div>
        <h3 className="text-sm font-semibold">Moderation log</h3>
        <p className="text-xs text-muted-foreground">
          Everything done here by moderators, owners and admins, newest first.
        </p>
        {log.length === 0 ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="board-log-empty"
          >
            Nothing yet.
          </p>
        ) : (
          <ol className="mt-2 flex flex-col gap-1.5" data-testid="board-log">
            {log.map((entry) => {
              const liftable =
                canModerate &&
                entry.person !== null &&
                entry.person !== me &&
                mutes.get(entry.person)?.id === entry.id &&
                mayUndoBy(entry.actor);
              // Another moderator (or an owner or admin) may make a waiting longer mute take effect.
              const confirmable =
                canModerate &&
                pending.has(entry.id) &&
                entry.actor !== me &&
                entry.person !== me &&
                entry.askedUntil !== null;
              const opens =
                entry.action === "remove" ? entry.thread : entry.post;
              const openable = opens !== null && titleOf(opens) !== null;
              return (
                <li
                  className="text-xs"
                  data-testid="board-log-entry"
                  key={entry.id}
                >
                  <span className="text-muted-foreground">
                    {dateWords(entry.at)}:{" "}
                  </span>
                  {logSentence(entry, nameOf, titleOf)}
                  {openable && opens ? (
                    <button
                      className="ml-2 underline"
                      data-testid="board-log-open"
                      onClick={() => onOpenPost(opens)}
                      type="button"
                    >
                      Open
                    </button>
                  ) : null}
                  {confirmable && entry.person && entry.askedUntil ? (
                    <button
                      className="ml-2 underline disabled:opacity-50"
                      data-testid="board-log-confirm"
                      disabled={busy}
                      onClick={() => {
                        const { person, askedUntil, reason } = entry;
                        if (person && askedUntil)
                          void run(
                            () => actions.mute(person, askedUntil, reason),
                            "Longer mute confirmed.",
                          );
                      }}
                      type="button"
                    >
                      Confirm until {dateWords(entry.askedUntil)}
                    </button>
                  ) : null}
                  {liftable && entry.person ? (
                    <button
                      className="ml-2 underline disabled:opacity-50"
                      data-testid="board-log-unmute"
                      disabled={busy}
                      onClick={() => {
                        const person = entry.person;
                        if (person)
                          void run(
                            () => actions.unmute(person),
                            "Mute lifted.",
                          );
                      }}
                      type="button"
                    >
                      Lift mute
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
