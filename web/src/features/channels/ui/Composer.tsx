import { Paperclip, SendHorizonal } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { uploadBlob } from "@/shared/lib/upload-blob";

export interface EditTarget {
  eventId: string;
  content: string;
}

export function Composer({
  channelId,
  replyTo,
  editTarget,
  onPosted,
  onCancelReply,
  onCancelEdit,
}: {
  channelId: string;
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

  const pubkey = truncatePubkey(userPubkey());

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
      className="border-t border-black/10 bg-[#F8F8F8] px-4 py-3 dark:border-white/10 dark:bg-[#1B1B1B]"
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
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send(e);
          }
        }}
        rows={2}
        placeholder={`Message #${channelId.slice(0, 8)}…`}
        className="w-full resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 focus:outline-hidden focus:ring-1 focus:ring-black dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40 dark:focus:ring-white"
        data-testid="composer-input"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-black/40 dark:text-white/40">
          <button
            type="button"
            disabled={uploading || sending || isEditing}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Attach file"
            data-testid="attach-button"
            title="Attach a file"
          >
            <Paperclip className="h-3.5 w-3.5" />
            {uploading ? "Uploading…" : "Attach"}
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
          <span className="ml-1">
            posting as{" "}
            <span className="font-medium text-black/60 dark:text-white/60">
              {pubkey}
            </span>
            {identityError && " — sign in to post"}
          </span>
        </span>
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="composer-send"
        >
          <SendHorizonal className="h-4 w-4" />
          {sending ? "Sending…" : isEditing ? "Save edit" : "Send"}
        </button>
      </div>
    </form>
  );
}
