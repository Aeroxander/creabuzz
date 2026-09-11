import { ArrowUp, AtSign, Paperclip } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";
import { uploadBlob } from "@/shared/lib/upload-blob";
import {
  useMentionCandidates,
  candidateName,
} from "@/features/fleet/use-mention-candidates";
import { UserAvatar } from "@/shared/ui/UserAvatar";

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

  const isEditing = editTarget != null;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const tags: string[][] = [["h", channelId]];
      for (const pubkey of new Set(mentionPubkeys.current)) {
        tags.push(["p", pubkey]);
      }
      if (replyTo) {
        tags.push(["e", replyTo]);
      }
      if (isEditing) {
        tags.push(["e", editTarget.eventId]);
      }
      const signed = await signAsUser({
        kind: isEditing ? 40003 : 9,
        tags,
        content,
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "relay rejected the event");
      }
      setDraft("");
      mentionPubkeys.current = [];
      onPosted();
    } catch (error) {
      console.error("[composer]", error);
      toast.error(
        isEditing ? "Couldn't edit message" : "Couldn't send message",
        {
          description: error instanceof Error ? error.message : String(error),
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
  const mentionPubkeys = useRef<string[]>([]);
  const candidates = useMentionCandidates(channelId);

  const onDraftChange = (value: string) => {
    setDraft(value);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const atIndex = value.lastIndexOf("@", caret - 1);
    if (atIndex >= 0 && (atIndex === 0 || value[atIndex - 1] === " ")) {
      setMentionAt(atIndex);
      const token = value.slice(atIndex + 1, caret);
      setMentionQuery(token.length > 0 ? token.toLowerCase() : "");
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
    if (!mentionPubkeys.current.includes(pubkey)) {
      mentionPubkeys.current.push(pubkey);
    }
    setMentionQuery(null);
    setMentionAt(-1);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const pos = before.length + name.length + 2;
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const filteredMentions =
    mentionQuery !== null
      ? candidates.filter((c) =>
          candidateName(c).toLowerCase().includes(mentionQuery),
        )
      : [];

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
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUploading(false);
    }
  };

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
      <div className="rounded-2xl border border-black/10 bg-white px-3 pt-2.5 pb-2 shadow-xs dark:border-white/10 dark:bg-white/5">
        {mentionQuery !== null && filteredMentions.length > 0 ? (
          <div className="mb-1.5 rounded-md border border-black/10 bg-background shadow-lg dark:border-white/10">
            {filteredMentions.slice(0, 6).map((c) => (
              <button
                key={c.pubkey}
                type="button"
                onClick={() => pickMention(c.pubkey, candidateName(c))}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                data-testid="mention-option"
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
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e);
            }
          }}
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
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black text-white disabled:opacity-30 dark:bg-white dark:text-black"
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
