import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { Card } from "@/shared/ui/card";
import { StatusGlyph } from "@/shared/ui/StatusGlyph";
import { OnchainChip } from "./OnchainChip";
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

const GONE_TONE = {
  live: "live",
  waiting: "waiting",
  gone: "neutral",
} as const;

function KindBadge({ kind }: { kind: OrgNodeKind }) {
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
      {KIND_LABEL[kind]}
    </span>
  );
}

type OrgNodeCanvasCardProps = {
  placed: PlacedNode;
  metrics: CanvasMetrics;
  selected: boolean;
  /** Ancestor names for the hover tooltip ("Founder › CTO"). */
  ancestorLabel: string;
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  onSelect: (dtag: string) => void;
};

/**
 * One node on the org canvas. Memoized: panning/zooming only changes the
 * wrapper transform, so cards must not re-render per pointer event.
 *
 * The status dot overlays agent-seat liveness (kind:44010/44200 derived in
 * lib/nodeLiveness.ts) using the status-* tokens (reference §2.2
 * statusDotColor): live/waiting/gone from the node's agent seats; a
 * human-only node shows no dot. The kind badge carries the node's role.
 */
export const OrgNodeCanvasCard = React.memo(function OrgNodeCanvasCard({
  placed,
  metrics,
  selected,
  ancestorLabel,
  liveness,
  onSelect,
}: OrgNodeCanvasCardProps) {
  const node = placed.treeNode.node;
  const occupants = React.useMemo(
    () => [...node.holders, ...node.agentSeats],
    [node.holders, node.agentSeats],
  );
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
        "absolute cursor-pointer select-none p-2 hover:shadow-md",
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
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {nodeStatus && (
            <StatusGlyph
              aria-label={LIVE_ARIA[nodeStatus]}
              className={cn(nodeStatus === "gone" && "opacity-60")}
              tone={GONE_TONE[nodeStatus]}
            />
          )}
          <span className="truncate text-sm font-semibold leading-tight">
            {node.name}
          </span>
        </span>
        <KindBadge kind={node.kind} />
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        {occupants.slice(0, 3).map((pubkey) => (
          <UserAvatar
            key={pubkey}
            avatarUrl={null}
            displayName={pubkey}
            size="xs"
          />
        ))}
        {occupants.length > 3 && (
          <span className="text-3xs text-muted-foreground">
            +{occupants.length - 3}
          </span>
        )}
        {occupants.length === 0 && (
          <span className="text-3xs text-muted-foreground">no occupants</span>
        )}
        {node.agentSeats.length > 0 && (
          <span className="ml-auto text-3xs text-muted-foreground">
            {node.agentSeats.length} agent seat
            {node.agentSeats.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {node.onchain && (
        <div className="mt-1.5">
          <OnchainChip
            address={node.onchain.dao}
            chain={node.onchain.chain}
            label={`Bound to DAO ${node.onchain.dao} on ${node.onchain.chain}`}
          />
        </div>
      )}
    </Card>
  );
});
