import * as React from "react";
import {
  GitBranch,
  Users,
  Shield,
  Plus,
  MoreHorizontal,
  Trash2,
  X,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { AgentStopControl } from "@/features/agents/ui/AgentStopControl";
import { Card } from "@/shared/ui/card";
import { EmptyState } from "@/shared/ui/EmptyState";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { PubKey } from "@/shared/ui/PubKey";
import { Spinner } from "@/shared/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useAgentLivenessQuery, useDeleteOrgNodeMutation } from "../hooks";
import {
  collectAgentSeats,
  newestSeenPerSeat,
  type AgentLiveness,
} from "../lib/nodeLiveness";
import { pluralize } from "../lib/format";
import { buildOrgTree, orgChartSummary, type OrgTreeNode } from "../lib/tree";
import type { CanvasDensity } from "../lib/canvasLayout";
import { LivenessBadge } from "./LivenessBadge";
import { OrgCanvas } from "./OrgCanvas";
import { OrgMetricRow } from "./OrgMetricRow";
import { OrgNodeForm } from "./OrgNodeForm";
import { OrgGrantForm } from "./OrgGrantForm";
import { OrgGrantChainView } from "./OrgGrantChainView";
import { OnchainChip } from "./OnchainChip";
import { OrgRagequitAction } from "./OrgRagequitDialog";
import type { OrgNode, OrgChart as OrgChartType } from "../orgModels";
import type { UseQueryResult } from "@tanstack/react-query";

type ChartViewMode = "canvas" | "list";

type OrgChartProps = {
  query: UseQueryResult<OrgChartType, Error>;
  /**
   * Object a caller (the audit view's "affected object" links) wants opened:
   * the node is selected, the grant's detail sheet opens. `null` means "no
   * focus requested". Budget links are routed to the Budgets tab instead.
   */
  focus?: OrgChartFocus | null;
  /** Open the Budgets tab (budget metric chips and create flows). */
  onOpenBudgets: () => void;
};

/** Where an audit row's object link should land inside the chart tab. */
export type OrgChartFocus = {
  kind: "node" | "grant" | "budget";
  id: string;
};

/** Liveness decays even without new events, so re-derive it on a timer. */
const LIVENESS_TICK_MS = 30_000;

export function OrgChart({ query, focus, onOpenBudgets }: OrgChartProps) {
  const { data, isLoading, error } = query;
  const livenessQuery = useAgentLivenessQuery();
  const [nowTick, setNowTick] = React.useState(() =>
    Math.floor(Date.now() / 1_000),
  );
  React.useEffect(() => {
    const id = window.setInterval(
      () => setNowTick(Math.floor(Date.now() / 1_000)),
      LIVENESS_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, []);
  const [createNodeOpen, setCreateNodeOpen] = React.useState(false);
  const [createGrantOpen, setCreateGrantOpen] = React.useState(false);
  const [selectedParentDtag, setSelectedParentDtag] = React.useState<
    string | undefined
  >();
  // Canvas is the default; the indented list stays available both as the
  // screen-reader/small-window fallback and (in canvas mode) as the
  // accessible source of truth inside a collapsed "Node list" disclosure.
  const [viewMode, setViewMode] = React.useState<ChartViewMode>("canvas");
  const [density, setDensity] = React.useState<CanvasDensity>("comfortable");
  const [selectedNodeDtag, setSelectedNodeDtag] = React.useState<
    string | undefined
  >();
  const handleSelectNode = React.useCallback((dtag: string) => {
    setSelectedNodeDtag((current) => (current === dtag ? undefined : dtag));
  }, []);
  // Audit-row deep links: select the node. Grant focus is threaded to
  // OrgGrantChainView (its sheet owns that state); budget links land on the
  // Budgets tab (OrgView routes them there).
  React.useEffect(() => {
    if (!focus) return;
    if (focus.kind === "node") {
      setSelectedNodeDtag(focus.id);
    }
  }, [focus]);

  // Liveness derivation must live before the early returns (rules of hooks).
  const agentSeats = React.useMemo(
    () => collectAgentSeats(data?.nodes ?? []),
    [data?.nodes],
  );
  const liveness = React.useMemo(
    () => newestSeenPerSeat(livenessQuery.data ?? [], agentSeats, nowTick),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [livenessQuery.data, agentSeats, nowTick],
  );

  if (isLoading) {
    return (
      <EmptyState
        icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
        testId="org-chart-loading"
        title="Loading org chart…"
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        action={
          <Button onClick={() => query.refetch()} size="sm" variant="outline">
            Retry
          </Button>
        }
        description="The relay did not answer the org query. Check the connection, then retry."
        testId="org-chart-error"
        title="Failed to load org chart"
        variant="error"
      />
    );
  }

  if (
    !data ||
    (data.nodes.length === 0 &&
      data.grants.length === 0 &&
      data.budgets.length === 0)
  ) {
    return (
      <EmptyState
        action={
          <Button
            onClick={() => {
              setSelectedParentDtag(undefined);
              setCreateNodeOpen(true);
            }}
            size="sm"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create First Node
          </Button>
        }
        description="No roles, teams, or budgets yet."
        icon={<Plus aria-hidden="true" className="h-5 w-5" />}
        testId="org-chart-empty"
        title="No org data yet"
      />
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Metric row — one implementation shared with the dashboard. */}
      <OrgMetricRow data={data} onFocusBudgets={onOpenBudgets} />
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <SegmentedControl
          legend="Chart view"
          onValueChange={(mode) => setViewMode(mode)}
          optionTestIdPrefix="org-view"
          options={
            [
              { value: "canvas", label: "Canvas" },
              { value: "list", label: "List" },
            ] as const
          }
          size="compact"
          testId="org-view-toggle"
          value={viewMode}
        />
        {viewMode === "canvas" && (
          <SegmentedControl
            legend="Canvas density"
            onValueChange={(next) => setDensity(next)}
            optionTestIdPrefix="org-density"
            options={
              [
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ] as const
            }
            size="compact"
            testId="org-density-toggle"
            value={density}
          />
        )}
        <div className="ml-auto flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setSelectedParentDtag(undefined);
              setCreateNodeOpen(true);
            }}
          >
            <Plus className="mr-1 h-3 w-3" />
            Node
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setCreateGrantOpen(true)}
          >
            <Plus className="mr-1 h-3 w-3" />
            Grant
          </Button>
        </div>
      </div>

      {/* Node tree (canvas + accessible list) */}
      {data.nodes.length > 0 && (
        <OrgNodeSection
          data={data}
          density={density}
          liveness={liveness}
          onSelectNode={handleSelectNode}
          selectedDtag={selectedNodeDtag}
          viewMode={viewMode}
          onCreateChild={(parentDtag) => {
            setSelectedParentDtag(parentDtag);
            setCreateNodeOpen(true);
          }}
        />
      )}

      {/* Grants */}
      {data.grants.length > 0 && (
        <OrgGrantChainView
          focusDtag={focus?.kind === "grant" ? focus.id : undefined}
          grants={data.grants}
          nodes={data.nodes}
        />
      )}

      {/* Dialogs */}
      <OrgNodeForm
        nodes={data.nodes}
        open={createNodeOpen}
        onOpenChange={setCreateNodeOpen}
        parentDtag={selectedParentDtag}
      />
      <OrgGrantForm
        open={createGrantOpen}
        onOpenChange={setCreateGrantOpen}
        nodes={data.nodes}
      />
    </div>
  );
}

// ── Node tree section ─────────────────────────────────────────────────────

function OrgNodeSection({
  data,
  density,
  liveness,
  viewMode,
  selectedDtag,
  onSelectNode,
  onCreateChild,
}: {
  data: OrgChartType;
  density: CanvasDensity;
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  viewMode: ChartViewMode;
  selectedDtag?: string;
  onSelectNode: (dtag: string) => void;
  onCreateChild: (parentDtag: string) => void;
}) {
  const tree = React.useMemo(() => buildOrgTree(data.nodes), [data.nodes]);
  const summary = React.useMemo(
    () => orgChartSummary(data.nodes, data.grants, data.budgets),
    [data.nodes, data.grants, data.budgets],
  );
  const liveAgentCount = React.useMemo(
    () =>
      [...liveness.values()].filter((entry) => entry.status === "live").length,
    [liveness],
  );

  const list = (
    <div className="space-y-0.5">
      {tree.roots.map((node) => (
        <OrgTreeNodeRow
          key={node.node.dtag}
          liveness={liveness}
          node={node}
          onCreateChild={onCreateChild}
        />
      ))}
    </div>
  );

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Roles &amp; Teams</h3>
      {viewMode === "canvas" ? (
        <>
          <OrgCanvas
            density={density}
            liveness={liveness}
            onSelect={onSelectNode}
            roots={tree.roots}
            selectedDtag={selectedDtag}
            summaryLabel={`Org chart: ${summary.nodeCount} nodes (${summary.roleCount} roles, ${summary.teamCount} teams, ${pluralize(summary.agentSeatCount, "agent seat")}), ${liveAgentCount} of ${summary.agentSeatCount} live, and ${summary.grantCount} active grants. Interactions are pointer-driven; the node list below the canvas is the accessible version of this chart.`}
          />
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Node list
            </summary>
            <div className="mt-1">{list}</div>
          </details>
        </>
      ) : (
        list
      )}
      {selectedDtag !== undefined && (
        <OrgNodeSelectionPanel
          data={data}
          dtag={selectedDtag}
          liveness={liveness}
          onClose={() => onSelectNode(selectedDtag)}
          tree={tree}
        />
      )}
    </div>
  );
}

// ── Selected node panel ───────────────────────────────────────────────────

/**
 * Per-node drill-in shown when a canvas card is clicked: that node's
 * occupants, the delegations issued through it, and the budgets covering its
 * occupants. The full grant chain and budget sections below stay rendered —
 * this panel narrows, it never replaces.
 */
function OrgNodeSelectionPanel({
  data,
  dtag,
  liveness,
  onClose,
  tree,
}: {
  data: OrgChartType;
  dtag: string;
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  onClose: () => void;
  tree: ReturnType<typeof buildOrgTree>;
}) {
  const treeNode = tree.byDtag.get(dtag);
  if (!treeNode) return null;
  const node = treeNode.node;
  const occupants = [...node.holders, ...node.agentSeats];
  const agentSeatSet = new Set(
    node.agentSeats.map((seat) => seat.trim().toLowerCase()),
  );
  const occupantSet = new Set(occupants);
  const now = Math.floor(Date.now() / 1000);
  const viaGrants = data.grants.filter(
    (g) =>
      !g.revoked &&
      g.via === dtag &&
      !(g.expires !== undefined && now >= g.expires),
  );
  const budgets = data.budgets.filter(
    (b) => !b.revoked && occupantSet.has(b.subject),
  );

  return (
    <Card className="mt-2 p-3" data-testid="org-node-selection">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{node.name}</span>
          <span className="text-2xs uppercase tracking-wide text-muted-foreground">
            {node.kind.replace("_", " ")}
          </span>
          {node.onchain && (
            <OnchainChip
              address={node.onchain.dao}
              chain={node.onchain.chain}
              label={`Bound to DAO ${node.onchain.dao} on ${node.onchain.chain}`}
            />
          )}
        </div>
        <Button
          aria-label={`Deselect ${node.name}`}
          className="h-6 w-6 shrink-0 p-0"
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Occupants: </span>
          {occupants.length > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
              {occupants.map((pubkey) => {
                const seat = pubkey.trim().toLowerCase();
                const status = agentSeatSet.has(seat)
                  ? liveness.get(seat)?.status
                  : undefined;
                return (
                  <span className="inline-flex items-center gap-1" key={pubkey}>
                    <PubKey pubkey={pubkey} interactive={false} />
                    {status && <LivenessBadge status={status} />}
                  </span>
                );
              })}
            </span>
          ) : (
            "none"
          )}
        </div>
        <div>
          <span className="font-medium text-foreground">
            Delegations through this node ({viaGrants.length}):{" "}
          </span>
          {viaGrants.length > 0
            ? viaGrants.map((g) => g.verbs.join(", ") || g.dtag).join(" · ")
            : "none"}
        </div>
        <div>
          <span className="font-medium text-foreground">
            Budgets covering its occupants ({budgets.length}):{" "}
          </span>
          {budgets.length > 0
            ? budgets
                .map((b) => `${b.subject || b.dtag} (${b.window})`)
                .join(" · ")
            : "none"}
        </div>
      </div>
    </Card>
  );
}

function NodeOnchainChip({ node }: { node: OrgNode }) {
  if (!node.onchain) return null;
  return (
    <OnchainChip
      address={node.onchain.dao}
      chain={node.onchain.chain}
      label={`Bound to DAO ${node.onchain.dao} on ${node.onchain.chain}`}
    />
  );
}

function OccupantChips({
  pubkeys,
  liveness,
  agentSeats,
}: {
  pubkeys: string[];
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  /** Seats held by agents (lowercase pubkeys) — these get a stop control. */
  agentSeats: ReadonlySet<string>;
}) {
  if (pubkeys.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
      {pubkeys.map((pubkey) => {
        const status = liveness.get(pubkey.trim().toLowerCase())?.status;
        return (
          <span className="inline-flex items-center gap-1" key={pubkey}>
            <PubKey
              className="text-xs text-muted-foreground"
              pubkey={pubkey}
              interactive={false}
            />
            {status && <LivenessBadge status={status} />}
            {agentSeats.has(pubkey.trim().toLowerCase()) ? (
              <AgentStopControl
                className="h-5 px-1.5 text-2xs"
                target={{
                  pubkey: pubkey.trim().toLowerCase(),
                  name: truncatePubkey(pubkey),
                }}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function OrgTreeNodeRow({
  node,
  liveness,
  onCreateChild,
}: {
  node: OrgTreeNode;
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  onCreateChild: (parentDtag: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const deleteMutation = useDeleteOrgNodeMutation();
  const hasChildren = node.children.length > 0;
  const occupants = [...node.node.holders, ...node.node.agentSeats];

  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted/50"
        style={{ paddingLeft: `${node.depth * 20 + 8}px` }}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.node.name}`}
            className="shrink-0 h-4 w-4 text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span aria-hidden="true" className="block h-3.5 w-3.5 shrink-0" />
        )}

        {/* Node icon */}
        <OrgNodeIcon kind={node.node.kind} />

        {/* Node name + details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate block">
              {node.node.name}
            </span>
            {node.depth === 0 && <NodeOnchainChip node={node.node} />}
          </div>
          <OccupantChips
            agentSeats={
              new Set(node.node.agentSeats.map((s) => s.trim().toLowerCase()))
            }
            liveness={liveness}
            pubkeys={occupants}
          />
        </div>

        {/* Context menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Node actions for ${node.node.name}`}
              className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted"
              type="button"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onCreateChild(node.node.dtag)}>
              <Plus className="mr-2 h-3.5 w-3.5" />
              Add Child
            </DropdownMenuItem>
            {/* Exit right on a bound org (NIP-ORG): read-by-default, hint
                without a configured EVM value layer. */}
            {node.node.onchain && (
              <OrgRagequitAction onchain={node.node.onchain} />
            )}
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => deleteMutation.mutate(node.node.dtag)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Children */}
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <OrgTreeNodeRow
            key={child.node.dtag}
            liveness={liveness}
            node={child}
            onCreateChild={onCreateChild}
          />
        ))}
    </div>
  );
}

function OrgNodeIcon({ kind }: { kind: OrgNode["kind"] }) {
  const icon = {
    role: <Shield className="h-3.5 w-3.5" />,
    team: <Users className="h-3.5 w-3.5" />,
    agent_seat: <GitBranch className="h-3.5 w-3.5" />,
  }[kind];
  return (
    <span className="shrink-0 flex h-5 w-5 items-center justify-center text-muted-foreground">
      {icon}
    </span>
  );
}
