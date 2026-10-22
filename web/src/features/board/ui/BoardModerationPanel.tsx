/**
 * Who moderates this board and what they have done: the appointed moderators with the end of their term, and the
 * board's public moderation log in plain words. Everyone sees both. The board's owners and admins can appoint and
 * dismiss moderators here; a moderator can step down; moderators can lift a mute that is still in force. The server
 * decides each of these and its reason is shown when it refuses.
 */

import { useState } from "react";
import { toast } from "sonner";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  activeMutes,
  type BoardState,
  type LogEntry,
  logSentence,
  MODERATOR_TERM_DAYS,
} from "../lib/board-moderation";
import { parsePersonInput } from "../lib/members";
import type { BoardModerationActions } from "../use-board-moderation";
import { AuthorChip } from "./AuthorChip";

function dateWords(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function BoardModerationPanel({
  state,
  log,
  me,
  canModerate,
  canManage,
  actions,
}: {
  state: BoardState;
  log: LogEntry[];
  me: string | null;
  canModerate: boolean;
  canManage: boolean;
  actions: BoardModerationActions;
}) {
  const now = Math.floor(Date.now() / 1000);
  const moderators = [...state.moderators].filter(([, until]) => until > now);
  const mutes = activeMutes(log, now);
  const people = [
    ...new Set([
      ...moderators.map(([pubkey]) => pubkey),
      ...log.flatMap((entry) =>
        entry.person ? [entry.actor, entry.person] : [entry.actor],
      ),
    ]),
  ];
  const profiles = useProfiles(people).data;
  const nameOf = (pubkey: string) =>
    pubkey === me ? "you" : resolveUserName(profiles?.[pubkey], pubkey);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
    const pubkey = parsePersonInput(text);
    if (pubkey === null) {
      setProblem("Paste their public key or npub… address.");
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
      <div>
        <h3 className="text-sm font-semibold">Moderators</h3>
        <p className="text-xs text-muted-foreground">
          Appointed by this board's owners and admins for up to{" "}
          {MODERATOR_TERM_DAYS} days. They can lock, pin and remove posts and
          mute people on this board, but never act against each other or the
          owners and admins, and each can take at most 20 actions an hour.
        </p>
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
                <AuthorChip profile={profiles?.[pubkey]} pubkey={pubkey} />
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
                    onClick={() =>
                      void run(
                        () => actions.dismiss(pubkey),
                        "Moderator dismissed.",
                      )
                    }
                    type="button"
                  >
                    Dismiss
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
              placeholder="Public key or npub… address"
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
                mutes.get(entry.person)?.id === entry.id;
              return (
                <li
                  className="text-xs"
                  data-testid="board-log-entry"
                  key={entry.id}
                >
                  <span className="text-muted-foreground">
                    {dateWords(entry.at)}:{" "}
                  </span>
                  {logSentence(entry, nameOf)}
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
