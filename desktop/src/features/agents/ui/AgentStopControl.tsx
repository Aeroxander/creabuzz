import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { useAgentStop } from "../agentStopFlow";
import {
  AgentStopConfirmDialog,
  type AgentStopTarget,
} from "./AgentStopConfirmDialog";

/**
 * The "Stop agent" button + confirm dialog, drop-in for any surface that
 * shows one of the user's agents (agent cards, org seat chips). Runs the
 * shared emergency-stop sequence and refreshes agents and seats afterwards.
 */
export function AgentStopControl({
  target,
  className,
  size = "sm",
}: {
  target: AgentStopTarget;
  className?: string;
  size?: "sm" | "xs";
}) {
  const [open, setOpen] = useState(false);
  const { run, refresh } = useAgentStop();

  return (
    <>
      <Button
        aria-label={`Stop agent ${target.name}`}
        // pointer-events-auto: agent-card footers are pointer-events-none so
        // the card's overlay button owns the click; this control re-enables it.
        className={`pointer-events-auto ${className ?? ""}`}
        data-testid={`stop-agent-${target.pubkey}`}
        onClick={(event) => {
          // Never bubble into the card's open-profile overlay button.
          event.stopPropagation();
          setOpen(true);
        }}
        size={size === "xs" ? "sm" : size}
        type="button"
        variant="outline"
      >
        Stop agent
      </Button>
      <AgentStopConfirmDialog
        onFinished={refresh}
        onOpenChange={setOpen}
        open={open}
        run={(ban) => run([target.pubkey], { ban })}
        targets={[target]}
      />
    </>
  );
}
