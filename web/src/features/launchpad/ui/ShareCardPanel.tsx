/**
 * A project's share picture and what to do with it: Download image, the system share sheet where the browser allows
 * sharing a file, and (on the scorecard) one click to post it to Home. The picture is drawn by `share-card.ts` from the
 * signed record: the project's mark, name, goal and one fact line, never a price or returns.
 *
 * Nothing is said to have happened that did not: a download that could not be made, a share sheet that failed or a post
 * that was refused each say so, and a post whose picture did not upload says that only the words went up.
 */

import { useEffect, useState } from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { buildPost } from "@/features/feed/lib/feed-events";
import { useSocialPublish } from "@/features/social/use-social-actions";
import { existingUserPubkey } from "@/shared/lib/identity";
import { failureWords } from "@/shared/lib/readable-error";
import { uploadBlob } from "@/shared/lib/upload-blob";
import { Button } from "@/shared/ui/button";

import {
  cardAlt,
  cardFileName,
  loadMarkImage,
  renderShareCard,
  type ShareCardInput,
} from "../lib/share-card";

type Made = { file: File; url: string } | "failed" | null;
type Notice = { problem: boolean; text: string } | null;

/** Whether this browser can hand a picture to the system share sheet. */
function canShareFiles(): boolean {
  try {
    if (
      typeof navigator.share !== "function" ||
      typeof navigator.canShare !== "function"
    )
      return false;
    return navigator.canShare({
      files: [new File([""], "card.png", { type: "image/png" })],
    });
  } catch {
    return false;
  }
}

export function ShareCardPanel({
  project,
  card,
  words,
  preview = false,
  postToHome = false,
}: {
  project: { id: string; author: string; image?: string | null };
  /** Memoize it: the picture is drawn again when it changes. */
  card: ShareCardInput;
  /** The sentence and link that go with the picture. */
  words: string;
  preview?: boolean;
  postToHome?: boolean;
}) {
  const [made, setMade] = useState<Made>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);
  const [shareable] = useState(canShareFiles);
  const publish = useSocialPublish();

  // The picture is made as soon as the card is known, so the share sheet is opened straight from the tap.
  useEffect(() => {
    let stale = false;
    let url: string | null = null;
    setMade(null);
    void (async () => {
      try {
        const mark = await loadMarkImage(project.image);
        const blob = await renderShareCard(card, mark);
        if (stale) return;
        if (!blob) {
          setMade("failed");
          return;
        }
        url = URL.createObjectURL(blob);
        setMade({
          file: new File([blob], cardFileName(card.name, card.app), {
            type: "image/png",
          }),
          url,
        });
      } catch {
        if (!stale) setMade("failed");
      }
    })();
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [card, project.image]);

  const ready = made !== null && made !== "failed" ? made : null;

  const download = () => {
    if (!ready) return;
    const link = document.createElement("a");
    link.href = ready.url;
    link.download = ready.file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setNotice({ problem: false, text: "Image downloaded." });
  };

  const share = async () => {
    if (!ready) return;
    setNotice(null);
    try {
      await navigator.share({
        files: [ready.file],
        title: `${card.name} on ${card.app}`,
        text: words,
      });
    } catch (error) {
      // Closing the sheet is a choice, not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice({
        problem: true,
        text: "Couldn't open the share sheet. Download the image instead.",
      });
    }
  };

  const post = async () => {
    if (existingUserPubkey() === null) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      let text = words;
      let withPicture = false;
      if (ready) {
        try {
          const uploaded = await uploadBlob(ready.file);
          text = `${words}\n\n${uploaded.url}`;
          withPicture = true;
        } catch {
          // The words still go up; the notice below says the picture did not.
        }
      }
      await publish.mutateAsync(
        buildPost({
          text,
          launch: { pubkey: project.author, id: project.id },
        }),
      );
      setPosted(true);
      setNotice({
        problem: false,
        text: withPicture
          ? "Posted to Home."
          : "Posted to Home. The picture did not upload, so only the words went up.",
      });
    } catch (error) {
      setNotice({
        problem: true,
        text: `${failureWords(error, "Couldn't post it.").text} Nothing was posted. Try again.`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="share-card">
      {preview ? (
        <div className="aspect-[1200/630] w-full overflow-hidden rounded-xl border bg-muted/30">
          {ready ? (
            <img
              alt={cardAlt(card)}
              className="h-full w-full object-cover"
              data-testid="share-card-image"
              src={ready.url}
            />
          ) : made === "failed" ? (
            <p
              className="p-3 text-sm text-muted-foreground"
              data-testid="share-card-failed"
              role="status"
            >
              This browser can't draw the picture. Copy the link instead.
            </p>
          ) : (
            <p className="p-3 text-sm text-muted-foreground" role="status">
              Making the picture…
            </p>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="max-sm:h-11"
          data-testid="share-card-download"
          disabled={!ready}
          onClick={download}
          size="sm"
          type="button"
          variant="outline"
        >
          Download image
        </Button>
        {shareable ? (
          <Button
            className="max-sm:h-11"
            data-testid="share-card-native"
            disabled={!ready}
            onClick={() => void share()}
            size="sm"
            type="button"
            variant="outline"
          >
            Share image
          </Button>
        ) : null}
        {postToHome ? (
          <Button
            className="max-sm:h-11"
            data-testid="share-card-post"
            disabled={busy || posted || made === null}
            onClick={() => void post()}
            size="sm"
            type="button"
          >
            {busy ? "Posting…" : posted ? "Posted" : "Post to Home"}
          </Button>
        ) : null}
      </div>
      <p
        className="min-h-4 text-xs"
        data-testid="share-card-status"
        role={notice?.problem ? "alert" : "status"}
      >
        {notice?.text ?? ""}
      </p>
    </div>
  );
}
