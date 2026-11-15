/**
 * "Your project is live": the first thing a founder sees after Start (`?started=1`). It gives them the public link to
 * copy or share, says when the first update is due, offers the weekly calendar reminder, and asks them to bring three
 * people to follow. It can be put away; the page then drops `?started=1`, so a reload does not bring it back.
 *
 * The share picture and sentence are the ones `ShareRecordButton` makes for a brand-new project: they say it just
 * started and never a price or a return.
 */

import { X } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import {
  projectPageUrl,
  weeklyReminderFileName,
  weeklyReminderIcs,
} from "../lib/calendar-reminder";
import { firstUpdateWords } from "../lib/first-week";
import { projectSharePath } from "../lib/share";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";
import { downloadCalendarFile } from "./download-calendar";
import { ShareRecordButton } from "./ShareRecordButton";
import { useUpdateDay } from "./use-update-day";

export function StartedCard({
  project,
  onDismiss,
}: {
  project: Launch["record"];
  onDismiss: () => void;
}) {
  const headingId = useId();
  const day = useUpdateDay(project);
  // The goal in the founder's words, for the share picture; empty until it is read.
  const goal = useProjectRecord(project).record?.goals.primary?.text ?? "";
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");
  const link = `${window.location.origin}${projectSharePath(project)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("copied");
    } catch {
      setCopied("manual");
    }
  };
  return (
    <section
      aria-labelledby={headingId}
      className="glass rounded-2xl border border-primary/40 p-4"
      data-testid="started-card"
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          className="text-lg font-semibold text-black dark:text-white"
          id={headingId}
        >
          Your project is live
        </h2>
        <Button
          aria-label="Close this card"
          data-testid="started-dismiss"
          onClick={onDismiss}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X aria-hidden className="h-4 w-4" />
        </Button>
      </div>
      <p className="mt-1 text-sm">
        This is your project's link. Share it so people can read your project
        and follow it.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          aria-label="Your project's link"
          className="h-9 min-w-48 flex-1 rounded-lg border bg-background px-2 text-sm"
          data-testid="started-link"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={link}
        />
        <Button
          data-testid="started-copy"
          onClick={() => void copy()}
          type="button"
          variant="outline"
        >
          Copy link
        </Button>
        <ShareRecordButton
          answered={null}
          card="started"
          goal={goal}
          kept={null}
          label="Share it"
          project={project}
          streak={null}
          variant="outline"
          withImage
        />
      </div>
      <p
        className="mt-1 min-h-4 text-xs text-muted-foreground"
        data-testid="started-copy-status"
        role="status"
      >
        {copied === "copied"
          ? "Copied. Paste it anywhere."
          : copied === "manual"
            ? "Couldn't copy it for you. Select the link above and copy it."
            : ""}
      </p>
      <p
        className="mt-1 text-sm font-medium"
        data-testid="started-first-update"
      >
        {firstUpdateWords(project.startedAt, Math.floor(Date.now() / 1000))}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          data-testid="started-reminder"
          onClick={() =>
            downloadCalendarFile(
              weeklyReminderFileName(project),
              weeklyReminderIcs(
                {
                  id: project.id,
                  name: project.name,
                  url: projectPageUrl(window.location.origin, project),
                },
                { weekday: day.weekday },
              ),
            )
          }
          size="sm"
          type="button"
          variant="outline"
        >
          Add a weekly reminder
        </Button>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          A repeating event for your calendar app. Nothing is sent from here.
        </p>
      </div>
      <p className="mt-3 text-sm" data-testid="started-follow">
        Ask three people to follow. A project with a few readers is easier to
        keep up. Send them the link above.
      </p>
    </section>
  );
}
