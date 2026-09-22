import * as React from "react";

import { Bot, Link2, User, Users } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Card } from "@/shared/ui/card";
import { STATUS_TONE_CLASSES } from "@/shared/ui/statusTone";
import type { CanvasMetrics, PlacedNode } from "../lib/canvasLayout";
import {
  bestSeatStatus,
  type AgentLiveness,
  type AgentLivenessStatus,
} from "../lib/nodeLiveness";
import type { OrgNodeKind } from "../orgModels";

const KIND_LABEL: Record<OrgNodeKind, string> = {
  role: "Role",
  team: "Team",
  agent_seat: "Agent seat",
};

const LIVE_ARIA: Record<AgentLivenessStatus, string> = {
  live: "Node agents live",
  waiting: "Node agents waiting",
  gone: "Node agents gone",
};

/** Liveness → status tier (§2.2 statusDotColor): live=green, waiting=amber,
 *  gone=gray. Routed through the semantic status tokens, never raw hues. */
const DOT_TONE: Record<AgentLivenessStatus, keyof typeof STATUS_TONE_CLASSES> =
  {
    live: "ok",
    waiting: "waiting",
    gone: "neutral",
  };

type OrgNodeCanvasCardProps = {
  placed: PlacedNode;
  metrics: CanvasMetrics;
  selected: boolean;
  /** Ancestor names for the hover tooltip ("Founder › CTO"). */
  ancestorLabel: string;
  /** Compact density: smaller avatar + fewer lines, not smaller fonts. */
  compact?: boolean;
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  onSelect: (dtag: string) => void;
};

/**
 * One node on the org canvas (paperclip-ux-reference.md §2.2): a horizontal
 * card with a round avatar + overlaid liveness dot on the left and a
 * name/kind/machine-id stack on the right. Memoized: panning/zooming only
 * changes the wrapper transform, so cards must not re-render per pointer
 * event.
 *
 * The status dot overlays agent-seat liveness (kind:44010/44200 derived in
 * lib/nodeLiveness.ts); a human-only node shows a person icon and no dot.
 * The onchain DAO binding renders as a tiny corner indicator — the full
 * chip lives in the drill-in panel.
 *
 * Density contract: compact shrinks the avatar (w-7 h-7) and drops the
 * machine-value line; font sizes never change between densities.
 */
export const OrgNodeCanvasCard = React.memo(function OrgNodeCanvasCard({
  placed,
  metrics,
  selected,
  ancestorLabel,
  compact = false,
  liveness,
  onSelect,
}: OrgNodeCanvasCardProps) {
  const node = placed.treeNode.node;
  const seatStatuses = React.useMemo(
    () =>
      node.agentSeats.map(
        (seat) => liveness.get(seat.trim().toLowerCase())?.status,
      ),
    [node.agentSeats, liveness],
  );
  const nodeStatus = bestSeatStatus(seatStatuses);
  const tooltip = ancestorLabel
    ? `${node.name} — reports to ${ancestorLabel}`
    : node.name;

  return (
    <Card
      aria-label={tooltip}
      className={cn(
        "absolute block cursor-pointer select-none py-0 transition-[box-shadow,border-color] duration-150 hover:border-foreground/20 hover:shadow-md",
        compact ? "px-3 py-2" : "px-4 py-3",
        selected && "ring-2 ring-ring",
      )}
      data-org-card=""
      data-testid={`org-canvas-node-${node.dtag}`}
      onClick={() => onSelect(node.dtag)}
      style={{
        left: placed.x,
        top: placed.y,
        width: metrics.cardW,
        minHeight: metrics.cardH,
      }}
      title={tooltip}
    >
      <div className={cn("flex items-center", compact ? "gap-2" : "gap-3")}>
        <div className="relative shrink-0">
          <div
            className={cn(
              "flex items-center justify-center rounded-full bg-muted",
              compact ? "h-7 w-7" : "h-9 w-9",
            )}
          >
            {node.kind === "agent_seat" ? (
              <Bot
                aria-hidden="true"
                className={cn(
                  "text-foreground/70",
                  compact ? "h-4 w-4" : "h-4.5 w-4.5",
                )}
              />
            ) : node.kind === "team" ? (
              <Users
                aria-hidden="true"
                className={cn(
                  "text-foreground/70",
                  compact ? "h-4 w-4" : "h-4.5 w-4.5",
                )}
              />
            ) : (
              <User
                aria-hidden="true"
                className={cn(
                  "text-foreground/70",
                  compact ? "h-4 w-4" : "h-4.5 w-4.5",
                )}
              />
            )}
          </div>
          {nodeStatus && (
            <span
              aria-label={LIVE_ARIA[nodeStatus]}
              role="img"
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card",
                STATUS_TONE_CLASSES[DOT_TONE[nodeStatus]].dot,
                nodeStatus === "gone" && "opacity-60",
              )}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start">
          <span className="truncate text-sm font-semibold leading-tight text-foreground">
            {node.name}
          </span>
          <span className="mt-0.5 leading-tight text-2xs text-muted-foreground">
            {KIND_LABEL[node.kind]}
          </span>
          {!compact && (
            <span className="mt-1 truncate font-mono leading-tight text-3xs text-muted-foreground/60">
              {node.dtag}
            </span>
          )}
        </div>
      </div>
      {node.onchain && (
        <span
          aria-label={`Bound to DAO ${node.onchain.dao} on ${node.onchain.chain}`}
          className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xs"
          data-testid={`org-canvas-onchain-${node.dtag}`}
          role="img"
          title={`Bound to DAO ${node.onchain.dao} on ${node.onchain.chain}`}
        >
          <Link2 aria-hidden="true" className="h-3 w-3" />
        </span>
      )}
    </Card>
  );
});
