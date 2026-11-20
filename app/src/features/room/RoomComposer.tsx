/**
 * Where a person who backs the project writes to the others who do (plan sections 4.7 and 7.6): a post, or an answer to one.
 * The text is kept in the box (and for a post, for the session) whatever happens: a refusal says in plain words what happened
 * and what to do next, and a server that has not caught up with a Back made seconds ago is tried once more by itself after 30
 * seconds. Enter makes a new line; Control or Command with Enter posts; Escape closes an answer.
 */
import { MAX_POST_CHARS } from "@creaton/core/social/feed/feed-events.ts";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { useToast } from "../../ui/toast";
import { ConfirmAccount } from "./ConfirmAccount";
import {
  COMPOSER_PLACEHOLDER,
  KIND_LINE,
  PUBLIC_LINE,
  type RoomRefusal,
  roomRefusal,
} from "./room-words";
import { useDraft } from "./use-draft";

/** How long a server that has not caught up is given before the one automatic second try. */
const RETRY_AFTER_MS = 30_000;

export function RoomComposer({
  draftKey,
  label,
  submit = "Post",
  send,
  onDone,
  onCancel,
  autoFocus = false,
  lines = true,
}: {
  /** Where the unsent text is kept (per project for a post). For an answer it is the post's, so the words survive closing the box; empty keeps them in the box only. */
  draftKey: string;
  label: string;
  submit?: string;
  /** Sends the text; a refusal throws the server's words. */
  send: (text: string) => Promise<unknown>;
  onDone?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** Says the two public lines under the box (the main composer). */
  lines?: boolean;
}) {
  const [text, setText] = useDraft(draftKey);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<RoomRefusal | null>(null);
  const toast = useToast();
  // The newest text and sender, so the one automatic try after a wait posts what is in the box then.
  const latest = useRef({ text, send });
  latest.current = { text, send };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retried = useRef(false);
  // A post on its way: the keyboard and the button both wait for it (a held key must not post the same words again).
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const size = [...text.trim()].length;
  const tooLong = size > MAX_POST_CHARS;

  const attempt = async (automatic: boolean) => {
    const body = latest.current.text;
    if (!body.trim() || [...body.trim()].length > MAX_POST_CHARS) return;
    if (inFlight.current) return;
    inFlight.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPending(true);
    try {
      await latest.current.send(body);
      // Words typed while the post was on its way are the person's: only what was sent is cleared.
      if (latest.current.text === body) setText("");
      setRefusal(null);
      retried.current = false;
      toast("Posted", "done");
      onDone?.();
    } catch (error) {
      const said = roomRefusal(
        error instanceof Error ? error.message : String(error),
      );
      setRefusal(said);
      // The server has not caught up yet: once more by itself, after a wait, and then it is the person's to press.
      if (said.catchingUp && !automatic && !retried.current) {
        retried.current = true;
        timer.current = setTimeout(() => void attempt(true), RETRY_AFTER_MS);
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      data-testid="room-composer"
      onSubmit={(event) => {
        event.preventDefault();
        retried.current = false;
        void attempt(false);
      }}
    >
      <TextArea
        autoFocus={autoFocus}
        count={{ used: size, max: MAX_POST_CHARS }}
        data-testid="room-composer-text"
        label={label}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (e.repeat) return;
            retried.current = false;
            void attempt(false);
          } else if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder={COMPOSER_PLACEHOLDER}
        problem={tooLong ? "That is longer than a post can be." : null}
        rows={lines ? 4 : 3}
        value={text}
      />
      {refusal ? (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-sm text-danger" data-testid="room-refusal">
            {refusal.words}
          </p>
          {refusal.catchingUp && timer.current ? (
            <p className="text-sm text-muted">
              Your words are kept. We will try once more in a moment.
            </p>
          ) : (
            <p className="text-sm text-muted">Your words are kept.</p>
          )}
          {refusal.needsLink ? <ConfirmAccount /> : null}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          data-testid="room-composer-send"
          disabled={!text.trim() || tooLong || pending}
          size="sm"
          type="submit"
        >
          {pending ? "Sending…" : submit}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} size="sm" variant="ghost">
            Not now
          </Button>
        ) : null}
      </div>
      {lines ? (
        <>
          <p className="text-xs text-muted" data-testid="room-public-line">
            {PUBLIC_LINE}
          </p>
          <p className="text-xs text-muted">{KIND_LINE}</p>
        </>
      ) : (
        <p className="text-xs text-muted">{PUBLIC_LINE}</p>
      )}
    </form>
  );
}
