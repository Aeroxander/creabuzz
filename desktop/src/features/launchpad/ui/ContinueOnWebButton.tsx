import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  launchWebUrl,
  type LaunchWebAction,
} from "@/features/launchpad/lib/webLinks";
import { Button } from "@/shared/ui/button";

/**
 * The one bidder-money affordance left on desktop: hand off to the web
 * app's canonical launch detail (the money plane). One label owner — the
 * button owns its own accessible name via `label`.
 */
export function ContinueOnWebButton({
  action,
  label,
  launch,
  relayOrigin,
  testid,
  variant = "default",
}: {
  action: LaunchWebAction;
  label: string;
  launch: { id: string; author: string };
  relayOrigin: string | null;
  testid: string;
  variant?: "default" | "outline";
}) {
  const url = launchWebUrl(relayOrigin, launch, action);
  return (
    <Button
      data-testid={testid}
      disabled={url === null}
      onClick={() => {
        if (url === null) return;
        void openUrl(url).catch(() =>
          toast.error("Couldn't open the web app in your browser."),
        );
      }}
      size="sm"
      type="button"
      variant={variant}
    >
      <ExternalLink aria-hidden className="mr-1 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
