import { effectiveLaunchStage } from "@/features/launchpad/lib/launchpadStatus";
import type { Launch } from "@/features/launchpad/launchpadModels";
import { ContinueOnWebButton } from "@/features/launchpad/ui/ContinueOnWebButton";
import { LaunchStageBadge } from "@/features/launchpad/ui/LaunchStageBadge";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

function mirroredLabel(count: number): string {
  return `${count} ${count === 1 ? "bid" : "bids"} mirrored`;
}

/**
 * Bidder-money handoff dialog. The desktop app no longer sends bids — the
 * web app owns the money plane (passkey-first custody, sponsored sends).
 * This dialog is launch status plus one "Continue on web" deep link into
 * web's canonical launch detail (`?action=bid`), not a send surface.
 */
export function BidOnWebDialog({
  onOpenChange,
  open,
  launch,
  relayOrigin,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  launch: Launch;
  relayOrigin: string | null;
}) {
  const { record } = launch;
  const stage = effectiveLaunchStage(launch);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-label="Back this launch on the web"
        data-testid="bid-on-web-dialog"
      >
        <DialogHeader>
          <DialogTitle>Back this launch on the web</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-1 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{record.name}</span>
            <LaunchStageBadge stage={stage} />
          </div>
          <p className="text-sm text-muted-foreground">
            {record.pitch || "No pitch yet."}
          </p>
          <p className="text-2xs text-muted-foreground">
            {record.auction
              ? `Auction deployed at ${truncatePubkey(record.auction)} · ${mirroredLabel(launch.bids.length)}.`
              : `Auction not deployed yet — bidding opens once the operator deploys it. ${mirroredLabel(launch.bids.length)}.`}
          </p>
          <p className="text-2xs text-muted-foreground">
            Bidding happens on the web app — same account, sponsored. Funds move
            with your web passkey, not the desktop operator key.
          </p>
          {relayOrigin === null ? (
            <p className="text-2xs text-destructive" role="alert">
              The relay address isn&apos;t resolved yet, so the web link
              can&apos;t be built. Reconnect the community, then try again.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Close
          </Button>
          <ContinueOnWebButton
            action="bid"
            label="Continue on web"
            launch={{ id: record.id, author: record.author }}
            relayOrigin={relayOrigin}
            testid="continue-on-web-bid"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
