/**
 * "Share your record": copies the project's link with one sentence about its record. When the browser will not
 * copy, the words are shown to copy by hand; nothing is said to have been copied that was not.
 */

import { useState } from "react";

import { APP_NAME } from "@/shared/constants/brand";
import { Button } from "@/shared/ui/button";

import { projectSharePath, shareWords } from "../lib/share";

export function ShareRecordButton({
  project,
  streak,
  kept,
  answered,
  label = "Share your record",
  variant = "default",
}: {
  project: { id: string; author: string; name: string };
  streak: number | null;
  kept: number | null;
  answered: number | null;
  label?: string;
  variant?: "default" | "outline";
}) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const words = shareWords({
    name: project.name,
    app: APP_NAME,
    streak,
    kept,
    answered,
    url: `${window.location.origin}${projectSharePath(project)}`,
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(words);
      setState("copied");
    } catch {
      setState("manual");
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="max-sm:h-11"
          data-testid="share-record"
          onClick={() => void copy()}
          type="button"
          variant={variant}
        >
          {label}
        </Button>
        <span
          className="text-xs text-muted-foreground"
          data-testid="share-record-status"
          role="status"
        >
          {state === "copied" ? "Copied. Paste it anywhere." : ""}
        </span>
      </div>
      {state === "manual" ? (
        <label className="flex flex-col gap-1 text-xs">
          Couldn't copy it for you. Select this and copy it:
          <textarea
            className="w-full rounded-lg border bg-background p-2 text-sm"
            data-testid="share-record-words"
            onFocus={(e) => e.currentTarget.select()}
            readOnly
            rows={3}
            value={words}
          />
        </label>
      ) : null}
    </div>
  );
}
