import { MAX_POST_CHARS } from "@creaton/core/social/feed/feed-events.ts";
import { MAX_PICTURES } from "@creaton/core/social/pictures.ts";
import { postParts, type QuoteRef } from "@creaton/core/social/post-compose.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import { ImagePlus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { isServerPicture } from "../../lib/server-picture";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { PictureDrafts } from "../pictures/PictureDrafts";
import { usePictureDrafts } from "../pictures/use-picture-drafts";
import {
  EDIT_EXPLAINED,
  EDITED_DONE,
  POSTED_DONE,
  QUOTING,
} from "./post-words";
import { QuotedPost } from "./QuotedPost";
import {
  OLD_NOT_REMOVED,
  type SignedEvent,
  usePublishComposed,
} from "./use-posts";

/** Room the post's own references take from its length: a quoted post's reference, and each picture's address. */
function reservedChars(pictures: number, quoting: boolean): number {
  const address = relayHttpBaseUrl().length + 80;
  return pictures * (address + 1) + (quoting ? 120 : 0);
}

/**
 * Writing a post, in a sheet over the screen: words, up to {@link MAX_PICTURES} pictures (each made ready and cleaned of hidden
 * details on this phone, described for people who use a screen reader, sent only when the post is sent), a post being quoted,
 * or a post being edited. About a project when `launch` is given. A failure keeps everything typed and picked.
 */
export function ComposerSheet({
  open,
  onOpenChange,
  launch,
  quote = null,
  edit = null,
  title = "Write a post",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launch?: { pubkey: string; id: string } | null;
  /** A post to quote: the box asks for words of your own. */
  quote?: QuoteRef | null;
  /** One of the person's own posts to change. */
  edit?: SignedEvent | null;
  title?: string;
}) {
  const parts = useMemo(
    () => (edit ? postParts(edit, isServerPicture) : null),
    [edit],
  );
  const [text, setText] = useState(parts?.text ?? "");
  const drafts = usePictureDrafts(parts?.pictures ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  const publish = usePublishComposed();
  const toast = useToast();
  const quoting = quote ?? parts?.quote ?? null;
  const limit = Math.max(
    0,
    MAX_POST_CHARS - reservedChars(drafts.drafts.length, quoting !== null),
  );
  const tooLong = text.length > limit;
  const empty = !text.trim() && drafts.drafts.length === 0;
  const busy = sending || drafts.preparing > 0;

  const addFiles = async (list: FileList | null) => {
    const picked = list ? [...list] : [];
    if (file.current) file.current.value = "";
    if (picked.length === 0) return;
    setProblem(await drafts.add(picked));
  };

  const send = async () => {
    setProblem(null);
    setSending(true);
    try {
      const pictures = await drafts.upload();
      const done = await publish.mutateAsync({
        text,
        pictures,
        launch: launch ?? parts?.launch ?? null,
        quote: quoting,
        replaces: edit,
      });
      setText("");
      drafts.clear();
      onOpenChange(false);
      if (done.oldRemoved) toast(edit ? EDITED_DONE : POSTED_DONE, "done");
      else toast(OLD_NOT_REMOVED, "problem");
    } catch (error) {
      // Nothing typed or picked is lost: the box stays as it is, with the reason.
      setProblem(
        error instanceof Error
          ? error.message
          : "Your post was not sent. Try again.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      description="Posts are public."
      onOpenChange={onOpenChange}
      open={open}
      testId="composer"
      title={title}
    >
      {edit ? (
        <p className="text-sm text-muted" data-testid="composer-edit-note">
          {EDIT_EXPLAINED}
        </p>
      ) : null}
      {quote ? (
        <div className="flex flex-col gap-1.5" data-testid="composer-quoting">
          <p className="text-xs font-semibold text-muted">{QUOTING}</p>
          <QuotedPost id={quote.id} />
        </div>
      ) : null}
      <TextArea
        count={{ used: text.length, max: limit }}
        data-testid="composer-text"
        label={quote ? "Your words" : "What's new?"}
        onChange={(e) => setText(e.target.value)}
        problem={tooLong ? "That is longer than a post can be." : null}
        rows={5}
        value={text}
      />
      <PictureDrafts
        drafts={drafts.drafts}
        onAlt={drafts.setAlt}
        onRemove={drafts.remove}
      />
      <input
        accept="image/jpeg,image/png,image/webp,image/gif"
        aria-hidden="true"
        className="hidden"
        data-testid="composer-file"
        multiple
        onChange={(e) => void addFiles(e.target.files)}
        ref={file}
        tabIndex={-1}
        type="file"
      />
      <Button
        data-testid="composer-add-picture"
        disabled={busy || drafts.drafts.length >= MAX_PICTURES}
        onClick={() => file.current?.click()}
        variant="secondary"
      >
        <ImagePlus aria-hidden="true" size={18} />
        {drafts.preparing > 0
          ? "Getting the picture ready…"
          : drafts.drafts.length >= MAX_PICTURES
            ? `Up to ${MAX_PICTURES} pictures`
            : "Add a picture"}
      </Button>
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="composer-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="composer-send"
        disabled={empty || tooLong || busy || (quote !== null && !text.trim())}
        onClick={() => void send()}
      >
        {sending ? "Sending…" : edit ? "Save" : "Post"}
      </Button>
    </Sheet>
  );
}
