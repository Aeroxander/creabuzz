/**
 * Share a project: its link (the existing `/p/<id>-<founder>` one, which shows only what the founder wrote), and a picture the person's own
 * device draws for the places that take a file. The picture carries no amount, no count of people, no gain figure and no
 * price (`share-card.ts`). Nothing is sent anywhere by this sheet: copying and sharing are the person's own presses.
 */
import { APP_NAME } from "@creaton/core/brand.ts";
import { useEffect, useState } from "react";
import { BannerText } from "../../app/MoneyBanner";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import type { ProjectNumbers } from "../money/numbers";
import { type Project, projectPath } from "./project-record";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  type CardContent,
  cardAlt,
  cardContent,
  cardFileName,
} from "./share-card";
import { renderShareCard } from "./share-card-draw";

/** Words of the sheet, in one place. */
export const SHARE_WORDS = {
  title: "Share this project",
  lead: "Anyone with the link can read the project. The link shows only what the founder wrote.",
  copy: "Copy link",
  copied: "Link copied.",
  copyFailed:
    "Your browser would not copy it. Select the link above and copy it.",
  share: "Share…",
  sharePicture: "Share the picture",
  savePicture: "Save the picture",
  noPicture: "This browser cannot make the picture. The link still works.",
  picturePreparing: "Making the picture…",
  linkLabel: "Link to this project",
} as const;

/** The project's link on this address. */
export function shareUrl(project: Pick<Project, "id" | "author">): string {
  return `${window.location.origin}${projectPath(project)}`;
}

export function ShareSheet({
  project,
  numbers,
  now,
  open,
  onOpenChange,
}: {
  project: Project;
  numbers: ProjectNumbers | null;
  now: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const card = cardContent(project, numbers, now);
  const link = shareUrl(project);
  const [said, setSaid] = useState<string | null>(null);
  const [picture, setPicture] = useState<Blob | null | "making">("making");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // What the picture says, as one string: the picture is drawn again only when this changes.
  const key = JSON.stringify(card);
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  // The picture is drawn when the sheet opens (and again if what it says changed), never before.
  useEffect(() => {
    if (!open) return;
    setPicture("making");
    let live = true;
    void renderShareCard(JSON.parse(key) as CardContent, APP_NAME).then(
      (blob) => {
        if (live) setPicture(blob);
      },
    );
    return () => {
      live = false;
    };
  }, [open, key]);
  useEffect(() => {
    if (!(picture instanceof Blob)) return setPreviewUrl(null);
    const url = URL.createObjectURL(picture);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [picture]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setSaid(SHARE_WORDS.copied);
    } catch {
      setSaid(SHARE_WORDS.copyFailed);
    }
  };
  const shareLink = async () => {
    try {
      await navigator.share({
        title: card.name,
        text: `${card.name} on ${APP_NAME}`,
        url: link,
      });
    } catch {
      // The person closed the share pane: nothing to say.
    }
  };
  const file = () =>
    picture instanceof Blob
      ? new File([picture], cardFileName(card.name, APP_NAME), {
          type: "image/png",
        })
      : null;
  const canShareFile = (f: File | null) =>
    Boolean(f && canShare && navigator.canShare?.({ files: [f] }));
  const pictureFile = file();
  const sharesFile = canShareFile(pictureFile);
  const sharePicture = async () => {
    if (!pictureFile) return;
    if (sharesFile) {
      try {
        await navigator.share({
          files: [pictureFile],
          title: card.name,
          text: `${card.name} on ${APP_NAME}`,
        });
      } catch {
        // The person closed the share pane.
      }
      return;
    }
    const url = URL.createObjectURL(pictureFile);
    const a = document.createElement("a");
    a.href = url;
    a.download = pictureFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) setSaid(null);
        onOpenChange(next);
      }}
      open={open}
      testId="share-sheet"
      title={SHARE_WORDS.title}
    >
      <p className="text-sm">{SHARE_WORDS.lead}</p>
      <Field
        data-testid="share-link"
        label={SHARE_WORDS.linkLabel}
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        value={link}
      />
      <div className="flex flex-col gap-2">
        <Button data-testid="share-copy" onClick={() => void copy()}>
          {SHARE_WORDS.copy}
        </Button>
        {canShare ? (
          <Button
            data-testid="share-native"
            onClick={() => void shareLink()}
            variant="secondary"
          >
            {SHARE_WORDS.share}
          </Button>
        ) : null}
      </div>
      {/* One live message, said once. */}
      <p
        aria-live="polite"
        className="min-h-5 text-sm text-muted"
        data-testid="share-said"
        role="status"
      >
        {said}
      </p>
      {picture === "making" ? (
        <p className="text-sm text-muted">{SHARE_WORDS.picturePreparing}</p>
      ) : picture === null ? (
        <p className="text-sm text-muted" data-testid="share-no-picture">
          {SHARE_WORDS.noPicture}
        </p>
      ) : (
        <>
          {previewUrl ? (
            <img
              alt={cardAlt(card)}
              className="w-full rounded-xl"
              data-testid="share-picture"
              height={CARD_HEIGHT}
              src={previewUrl}
              width={CARD_WIDTH}
            />
          ) : null}
          <Button
            data-testid="share-picture-press"
            onClick={() => void sharePicture()}
            variant="secondary"
          >
            {sharesFile ? SHARE_WORDS.sharePicture : SHARE_WORDS.savePicture}
          </Button>
        </>
      )}
      <BannerText testId="sheet-banner" />
    </Sheet>
  );
}
