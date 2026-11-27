/**
 * Share a project: its link (the existing `/p/<id>-<founder>` one, which shows only what the founder wrote). Nothing is sent
 * anywhere by this sheet: copying and sharing are the person's own presses.
 */
import { APP_NAME } from "@creaton/core/brand.ts";
import { useState } from "react";
import { BannerText } from "../../app/MoneyBanner";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { type Project, projectPath } from "./project-record";

/** Words of the sheet, in one place. */
export const SHARE_WORDS = {
  title: "Share this project",
  lead: "Anyone with the link can read the project. The link shows only what the founder wrote.",
  copy: "Copy link",
  copied: "Link copied.",
  copyFailed:
    "Your browser would not copy it. Select the link above and copy it.",
  share: "Share…",
  linkLabel: "Link to this project",
} as const;

/** The project's link on this address. */
export function shareUrl(project: Pick<Project, "id" | "author">): string {
  return `${window.location.origin}${projectPath(project)}`;
}

export function ShareSheet({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const link = shareUrl(project);
  const [said, setSaid] = useState<string | null>(null);
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

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
        title: project.name,
        text: `${project.name} on ${APP_NAME}`,
        url: link,
      });
    } catch {
      // The person closed the share pane: nothing to say.
    }
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
      <BannerText testId="sheet-banner" />
    </Sheet>
  );
}
