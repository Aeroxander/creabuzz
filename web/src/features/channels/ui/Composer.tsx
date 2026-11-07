import { ArrowUp, AtSign, Paperclip } from "lucide-react";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { uploadFailureWords } from "@/shared/lib/media-refusal";
import { uploadBlob } from "@/shared/lib/upload-blob";
import {
  useMentionCandidates,
  candidateName,
} from "@/features/fleet/use-mention-candidates";
import {
  useChannelTyping,
  useTypingBroadcast,
} from "@/features/presence/use-typing";
import { TypingIndicator } from "@/features/presence/ui/TypingIndicator";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { existingUserPubkey } from "@/shared/lib/identity";
import { hasNip07Provider } from "@/shared/lib/nostr-signer";
import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { failureWords } from "@/shared/lib/readable-error";

import {
  composerKey,
  mentionedPubkeys,
  mentionOptionId,
  type PickedMention,
} from "./composer-mentions";

export interface EditTarget {
  eventId: string;
  content: string;
}

export function Composer({
  channelId,
  channelName,
  replyTo,
  editTarget,
  onPosted,
  onCancelReply,
  onCancelEdit,
}: {
  channelId: string;
  channelName?: string;
  replyTo?: string | null;
  editTarget?: EditTarget | null;
  onPosted: () => void;
  onCancelReply?: () => void;
  onCancelEdit?: () => void;
}) {
  const [draft, setDraft] = useState(editTarget?.content ?? "");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [identityError, setIdentityError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Typing indicators: throttled broadcast while the draft changes, and the
  // live "X is typing…" line for everyone else in this channel.
  const notifyTyping = useTypingBroadcast(channelId, replyTo);
  const typingEntries = useChannelTyping(channelId);

  const isEditing = editTarget != null;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const tags: string[][] = [["h", channelId]];
      // Only people whose @Name is still in the words are told.
      for (const pubkey of mentionedPubkeys(content, mentionPicks.current)) {
        tags.push(["p", pubkey]);
      }
      if (replyTo) {
        tags.push(["e", replyTo]);
      }
      if (isEditing) {
        tags.push(["e", editTarget.eventId]);
      }
      await publishAsUser(
        {
          kind: isEditing ? 40003 : 9,
          tags,
          content,
        },
        isEditing
          ? "The server didn't accept your edit. Your words are still in the box; try saving again."
          : "The server didn't accept your message. Your words are still in the box; try sending again.",
      );
      setDraft("");
      mentionPicks.current = [];
      onPosted();
    } catch (error) {
      console.error("[composer]", error);
      toast.error(
        isEditing ? "Couldn't edit message" : "Couldn't send message",
        {
          description: failureWords(error).text,
        },
      );
      if (window.localStorage.getItem("buzz.identity.nsec") === null) {
        setIdentityError(true);
      }
    } finally {
      setSending(false);
    }
  };

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAt, setMentionAt] = useState<number>(-1);
  const mentionPicks = useRef<PickedMention[]>([]);
  const [activeMention, setActiveMention] = useState(0);
  const candidates = useMentionCandidates(channelId);

  const onDraftChange = (value: string) => {
    setDraft(value);
    notifyTyping();
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const atIndex = value.lastIndexOf("@", caret - 1);
    if (atIndex >= 0 && (atIndex === 0 || value[atIndex - 1] === " ")) {
      setMentionAt(atIndex);
      const token = value.slice(atIndex + 1, caret);
      setMentionQuery(token.length > 0 ? token.toLowerCase() : "");
      setActiveMention(0);
    } else {
      setMentionQuery(null);
    }
  };

  const pickMention = (pubkey: string, name: string) => {
    const at = mentionAt >= 0 ? mentionAt : draft.lastIndexOf("@");
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const before = at >= 0 ? draft.slice(0, at) : draft;
    const after = draft.slice(caret);
    const next = `${before}@${name} ${after}`;
    setDraft(next);
    mentionPicks.current.push({ pubkey, name });
    setMentionQuery(null);
    setMentionAt(-1);
    pendingCaret.current = before.length + name.length + 2;
  };

  // The caret goes right behind a chosen mention in the same commit that writes it, not a frame later: a key typed
  // straight after choosing would otherwise land at the end and then have the caret put back in front of it.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = textareaRef.current;
    if (pos === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  });

  const filteredMentions = (
    mentionQuery !== null
      ? candidates.filter((c) =>
          candidateName(c).toLowerCase().includes(mentionQuery),
        )
      : []
  ).slice(0, 6);
  const mentionListId = `composer-mentions-${channelId}`;
  const suggestionsOpen = mentionQuery !== null && filteredMentions.length > 0;

  const insertMention = () => {
    setDraft((previous) => `${previous}@`);
    textareaRef.current?.focus();
  };

  const attachFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const descriptor = await uploadBlob(file);
      const name = file.name.replace(/[[\]()]/g, "_");
      setDraft((previous) =>
        previous.length > 0
          ? `${previous}\n![${name}](${descriptor.url})`
          : `![${name}](${descriptor.url})`,
      );
    } catch (error) {
      console.error("[attach]", error);
      toast.error("Couldn't upload file", {
        description: uploadFailureWords(
          error,
          "The file didn't upload. Try again.",
        ).text,
      });
    } finally {
      setUploading(false);
    }
  };

  // Sending would create a key for a visitor, signing them up without the terms: ask them to make an account first.
  // Someone signing with a browser extension already has one.
  if (existingUserPubkey() === null && !hasNip07Provider()) {
    return (
      <div
        className="border-t border-black/10 px-4 py-3 text-sm text-black/70 dark:border-white/10 dark:text-white/70"
        data-testid="room-composer-sign-up"
      >
        <button
          className="font-semibold underline underline-offset-2"
          onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
          type="button"
        >
          {CREATE_ACCOUNT}
        </button>{" "}
        to write here. Reading needs no account.
      </div>
    );
  }

  return (
    <form
      onSubmit={send}
      className="border-t border-black/10 px-4 py-3 dark:border-white/10"
    >
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <span>Replying to a message</span>
          <button
            type="button"
            onClick={onCancelReply}
            className="text-black/60 underline dark:text-white/60"
          >
            cancel
          </button>
        </div>
      )}
      {isEditing && (
        <div className="mb-2 flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <span>Editing your message</span>
          <button
            type="button"
            onClick={onCancelEdit}
            className="text-black/60 underline dark:text-white/60"
          >
            cancel
          </button>
        </div>
      )}
      <TypingIndicator entries={typingEntries} />
      <div className="rounded-2xl border border-black/10 bg-white px-3 pt-2.5 pb-2 shadow-xs dark:border-white/10 dark:bg-white/5">
        {suggestionsOpen ? (
          <div
            aria-label="Mention suggestions"
            className="mb-1.5 rounded-md border border-black/10 bg-background shadow-lg dark:border-white/10"
            id={mentionListId}
            role="listbox"
          >
            {filteredMentions.map((c, i) => (
              <button
                aria-selected={i === activeMention}
                id={mentionOptionId(mentionListId, i)}
                key={c.pubkey}
                type="button"
                // Keep the caret in the box: the mention goes where it was typed.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(c.pubkey, candidateName(c))}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10${
                  i === activeMention ? " bg-black/5 dark:bg-white/10" : ""
                }`}
                data-testid="mention-option"
                role="option"
              >
                <UserAvatar
                  avatarUrl={null}
                  displayName={candidateName(c)}
                  size="xs"
                />
                <span className="truncate">{candidateName(c)}</span>
                {c.agent ? (
                  <span className="ml-auto text-2xs text-black/60 dark:text-white/60">
                    agent
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            const action = composerKey({
              key: e.key,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.nativeEvent.keyCode,
              suggestions: mentionQuery !== null ? filteredMentions.length : 0,
              active: activeMention,
            });
            if (action === null) return;
            e.preventDefault();
            if (action.type === "move") setActiveMention(action.index);
            else if (action.type === "close") setMentionQuery(null);
            else if (action.type === "pick") {
              const chosen = filteredMentions[action.index];
              if (chosen) pickMention(chosen.pubkey, candidateName(chosen));
            } else void send(e);
          }}
          aria-activedescendant={
            suggestionsOpen
              ? mentionOptionId(
                  mentionListId,
                  Math.min(activeMention, filteredMentions.length - 1),
                )
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={suggestionsOpen ? mentionListId : undefined}
          rows={2}
          placeholder={`Message #${channelName ?? channelId.slice(0, 8)}…`}
          className="w-full resize-none border-0 bg-transparent p-0 text-sm text-black placeholder:text-black/60 focus:outline-hidden focus:ring-0 dark:text-white dark:placeholder:text-white/40"
          data-testid="composer-input"
        />
        <div className="mt-1 flex items-center gap-0.5">
          <button
            type="button"
            onClick={insertMention}
            className="rounded-md p-1.5 text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Mention someone"
            title="Mention someone"
          >
            <AtSign className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={uploading || sending || isEditing}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md p-1.5 text-black/60 hover:bg-black/5 hover:text-black disabled:opacity-40 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Attach file"
            data-testid="attach-button"
            title={uploading ? "Uploading…" : "Attach a file"}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              void attachFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {identityError && (
            <span className="ml-1 text-xs text-black/60 dark:text-white/60">
              sign in to post
            </span>
          )}
          <span className="ml-auto" />
          {isEditing ? (
            <button
              type="submit"
              disabled={sending}
              className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              data-testid="composer-send"
            >
              Save edit
            </button>
          ) : (
            <button
              type="submit"
              disabled={sending || draft.trim().length === 0}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:opacity-30"
              aria-label="Send message"
              data-testid="composer-send"
              title="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
