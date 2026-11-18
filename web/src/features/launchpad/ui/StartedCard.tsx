/**
 * "Your project is live": one line under the header on the page a founder lands on after Start (`?started=1`): the
 * project's short link and "Copy". It can be put away; the page then drops `?started=1`, so a reload does not bring it
 * back. The weekly reminder and the picture are under "Share" in the header, and when the first update is due is on the
 * record line: nothing here repeats them.
 */

import { X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";

import { projectSharePath } from "../lib/share";
import type { Launch } from "../models";

export function StartedCard({
  project,
  onDismiss,
}: {
  project: Launch["record"];
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");
  const path = projectSharePath(project);
  const link = `${window.location.origin}${path}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("copied");
    } catch {
      setCopied("manual");
    }
  };
  return (
    <div
      className="glass flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-primary/40 px-3 py-1.5"
      data-testid="started-card"
    >
      <p className="min-w-0 flex-1 text-sm max-sm:truncate sm:break-all">
        <span className="font-semibold">Your project is live:</span>{" "}
        <span data-testid="started-link-short">
          {window.location.host}
          {path}
        </span>
      </p>
      <Button
        aria-label="Copy link"
        data-testid="started-copy"
        onClick={() => void copy()}
        size="sm"
        type="button"
        variant="outline"
      >
        Copy
      </Button>
      <Button
        aria-label="Close this line"
        data-testid="started-dismiss"
        onClick={onDismiss}
        size="icon"
        type="button"
        variant="ghost"
      >
        <X aria-hidden className="h-4 w-4" />
      </Button>
      <p
        aria-live="polite"
        className="w-full text-xs text-muted-foreground empty:hidden"
        data-testid="started-copy-status"
        role="status"
      >
        {copied === "copied"
          ? "Copied. Paste it anywhere."
          : copied === "manual"
            ? "Couldn't copy it for you. Select the link above and copy it."
            : ""}
      </p>
      {copied === "manual" ? (
        <input
          aria-label="Your project's link"
          className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
          data-testid="started-link"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={link}
        />
      ) : null}
    </div>
  );
}
