/**
 * One "Share" control on a project's header: copy the link, download the picture, and (for the founder) add a weekly
 * reminder to a calendar. It replaces four separate buttons that said nearly the same thing. A button with
 * `aria-expanded` opens the list; Escape closes it and gives the keyboard back to the button.
 *
 * The words and the picture are the ones the record supports (`shareWords`, `cardVariantsFor`): a new project says it
 * just started, never a price, a return or a number of Shares.
 */

import { Share2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { APP_NAME } from "@/shared/constants/brand";
import { Button } from "@/shared/ui/button";

import {
  projectPageUrl,
  weeklyReminderFileName,
  weeklyReminderIcs,
} from "../lib/calendar-reminder";
import { firstUpdateDue, projectSharePath, shareWords } from "../lib/share";
import { cardVariantsFor } from "../lib/share-card";
import { acceptedByOthers, doneAlone } from "../lib/task-checks";
import type { Launch } from "../models";
import { useProjectState } from "../use-my-projects";
import { useProjectRecord } from "../use-project-record";
import { downloadCalendarFile } from "./download-calendar";
import { ShareCardPanel } from "./ShareCardPanel";
import { useUpdateDay } from "./use-update-day";

export function ShareMenu({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const project = launch.record;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");
  const toggle = useRef<HTMLButtonElement | null>(null);
  const day = useUpdateDay(project);
  const s = useProjectState(project).data;
  const goal = useProjectRecord(project).record?.goals.primary?.text ?? "";
  const answered = s?.promises
    ? s.promises.kept + s.promises.missed + s.promises.changed
    : null;
  const accepted = s?.tasksKnown ? acceptedByOthers(s.tasks).length : null;
  // Work only the founder checked is a number of its own, never added to the accepted work.
  const done = s?.tasksKnown ? doneAlone(s.tasks).length : null;
  const fresh = Boolean(s?.updatesKnown && s.lastUpdateAt === null);
  const firstDue = fresh
    ? firstUpdateDue(project.startedAt, Math.floor(Date.now() / 1000))
    : null;
  const variant = cardVariantsFor({
    answered,
    accepted,
    doneAlone: done,
    fresh,
  })[0];
  const link = `${window.location.origin}${projectSharePath(project)}`;
  const words = shareWords({
    name: project.name,
    app: APP_NAME,
    streak: s?.streak ?? null,
    kept: s?.promises?.kept ?? null,
    answered,
    url: link,
    variant,
    accepted,
    doneAlone: done,
    firstDue,
  });
  const picture = useMemo(
    () => ({
      variant,
      name: project.name,
      goal,
      app: APP_NAME,
      streak: s?.streak ?? null,
      kept: s?.promises?.kept ?? null,
      answered,
      accepted,
      doneAlone: done,
      firstDue,
    }),
    [
      variant,
      project.name,
      goal,
      s?.streak,
      s?.promises?.kept,
      answered,
      accepted,
      done,
      firstDue,
    ],
  );
  const root = useRef<HTMLDivElement | null>(null);
  // Escape puts the list away and the keyboard back on the button that opened it; a press outside puts it away too.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    const onPress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("copied");
    } catch {
      setCopied("manual");
    }
  };

  return (
    <div className="relative" data-testid="share-menu" ref={root}>
      <Button
        aria-controls={id}
        aria-expanded={open}
        className="max-sm:h-11"
        data-testid="share-menu-toggle"
        onClick={() => setOpen((was) => !was)}
        ref={toggle}
        type="button"
        variant="outline"
      >
        <Share2 aria-hidden className="h-4 w-4" />
        Share
      </Button>
      {open ? (
        <div
          className="absolute right-0 top-full z-20 mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border bg-background p-3 shadow-lg"
          id={id}
        >
          <Button
            data-testid="share-menu-copy"
            onClick={() => void copy()}
            type="button"
            variant="outline"
          >
            Copy link
          </Button>
          <p
            className="min-h-4 text-xs text-muted-foreground"
            data-testid="share-menu-status"
            role="status"
          >
            {copied === "copied" ? "Copied. Paste it anywhere." : ""}
          </p>
          {copied === "manual" ? (
            <input
              aria-label="Your project's link"
              className="h-9 rounded-lg border bg-background px-2 text-sm"
              data-testid="share-menu-link"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={link}
            />
          ) : null}
          <ShareCardPanel card={picture} project={project} words={words} />
          {isFounder ? (
            <Button
              data-testid="share-menu-reminder"
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
              type="button"
              variant="outline"
            >
              Add a weekly reminder
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
