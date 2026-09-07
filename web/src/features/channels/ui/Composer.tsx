import { ArrowUp, AtSign, Paperclip } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";
import { uploadBlob } from "@/shared/lib/upload-blob";

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
        <div className="mb-2 flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
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
        <div className="mb-2 flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
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
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e);
            }
          }}
          rows={2}
          placeholder={`Message #${channelName ?? channelId.slice(0, 8)}…`}
          className="w-full resize-none border-0 bg-transparent p-0 text-sm text-black placeholder:text-black/40 focus:outline-hidden focus:ring-0 dark:text-white dark:placeholder:text-white/40"
          data-testid="composer-input"
        />
        <div className="mt-1 flex items-center gap-0.5">
          <button
            type="button"
            onClick={insertMention}
            className="rounded-md p-1.5 text-black/45 hover:bg-black/5 hover:text-black dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Mention someone"
            title="Mention someone"
          >
            <AtSign className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={uploading || sending || isEditing}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md p-1.5 text-black/45 hover:bg-black/5 hover:text-black disabled:opacity-40 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white"
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
            <span className="ml-1 text-xs text-black/40 dark:text-white/40">
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
