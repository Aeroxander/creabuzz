/**
 * What a reader can do about another person, from their profile or from a private conversation with them: stop seeing them
 * (mute) and tell the community's moderators about them (report). Mute only changes what this reader sees; a report goes to the
 * moderators' queue and nothing else, and nothing happens to the person because of it.
 */

import { Flag, VolumeX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { ReportSetting } from "@/features/moderation/lib/report";
import { ReportDialog } from "@/features/moderation/ui/ReportDialog";
import { Button } from "@/shared/ui/button";

import { useMutedPeople, useToggleMute } from "../use-social-actions";

export function MutePersonButton({
  pubkey,
  testId = "person-mute",
}: {
  pubkey: string;
  testId?: string;
}) {
  const mutedQuery = useMutedPeople();
  const muted = mutedQuery.data?.has(pubkey) ?? false;
  const toggleMute = useToggleMute();
  return (
    <Button
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      className="rounded-full"
      data-testid={testId}
      disabled={toggleMute.isPending || !mutedQuery.isSuccess}
      onClick={() =>
        toggleMute.mutate(
          { pubkey, muted: !muted },
          {
            onSuccess: () => toast.success(muted ? "Unmuted" : "Muted"),
            onError: (error) =>
              toast.error(
                error instanceof Error ? error.message : "That didn't work.",
              ),
          },
        )
      }
      size="icon"
      title={muted ? "Unmute" : "Mute"}
      type="button"
      variant="outline"
    >
      <VolumeX aria-hidden className={muted ? "text-red-600" : undefined} />
    </Button>
  );
}

export function ReportPersonButton({
  pubkey,
  name,
  testId = "person-report",
  setting = "community",
}: {
  pubkey: string;
  name: string;
  testId?: string;
  /** "conversation" from a private conversation: the report says the messages are not sent with it. */
  setting?: Extract<ReportSetting, "community" | "conversation">;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-label={`Report ${name}`}
        className="rounded-full"
        data-testid={testId}
        onClick={() => setOpen(true)}
        size="icon"
        title="Report"
        type="button"
        variant="outline"
      >
        <Flag aria-hidden />
      </Button>
      {open ? (
        <ReportDialog
          onClose={() => setOpen(false)}
          setting={setting}
          target={{ kind: "person", pubkey }}
          what={name}
        />
      ) : null}
    </>
  );
}
