import * as React from "react";
import {
  GitBranch,
  Users,
  Shield,
  DollarSign,
  AlertTriangle,
  Plus,
  MoreHorizontal,
  Trash2,
  X,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { EmptyState } from "@/shared/ui/EmptyState";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { MetricCard } from "@/shared/ui/MetricCard";
import { PubKey } from "@/shared/ui/PubKey";
import { Spinner } from "@/shared/ui/spinner";
import { UtilizationBar } from "@/shared/ui/UtilizationBar";
import {
  summarizeUtilizations,
  utilizationPercentage,
} from "@/shared/ui/utilizationThresholds";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  useBudgetUtilizationsQuery,
  useDeleteOrgNodeMutation,
  useDeleteOrgBudgetMutation,
} from "../hooks";
import { METRIC_FETCH_LIMIT } from "../lib/budgetConsumption";
import { buildOrgTree, orgChartSummary, type OrgTreeNode } from "../lib/tree";
import type { CanvasDensity } from "../lib/canvasLayout";
import { OrgCanvas } from "./OrgCanvas";
import { OrgNodeForm } from "./OrgNodeForm";
import { OrgGrantForm } from "./OrgGrantForm";
import { OrgBudgetForm } from "./OrgBudgetForm";
import { OrgGrantChainView } from "./OrgGrantChainView";
import { OrgBudgetConsumption } from "./OrgBudgetConsumption";
import { OnchainChip } from "./OnchainChip";
import type {
  OrgNode,
  OrgBudget,
  OrgChart as OrgChartType,
} from "../orgModels";
import type { UseQueryResult } from "@tanstack/react-query";

type ChartViewMode = "canvas" | "list";

type OrgChartProps = {
  query: UseQueryResult<OrgChartType, Error>;
};

export function OrgChart({ query }: OrgChartProps) {
  const { data, isLoading, error } = query;
  const [createNodeOpen, setCreateNodeOpen] = React.useState(false);
  const [createGrantOpen, setCreateGrantOpen] = React.useState(false);
  const [createBudgetOpen, setCreateBudgetOpen] = React.useState(false);
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
  const budgetsHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const focusBudgets = React.useCallback(() => {
    budgetsHeadingRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    budgetsHeadingRef.current?.focus({ preventScroll: true });
  }, []);

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

  const summary = orgChartSummary(data.nodes, data.grants, data.budgets);

  return (
    <div className="p-4 space-y-4">
      {/* Metric row */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard
          label="Nodes"
          testId="org-metric-nodes"
          value={summary.nodeCount}
        />
        <MetricCard
          description={`${summary.agentSeatCount} agent seats`}
          label="Active grants"
          testId="org-metric-grants"
          value={summary.grantCount}
        />
        <OrgBudgetMetricCards
          budgets={data.budgets}
          onFocusBudgets={focusBudgets}
        />
      </div>
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
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setCreateBudgetOpen(true)}
          >
            <Plus className="mr-1 h-3 w-3" />
            Budget
          </Button>
        </div>
      </div>

      {/* Node tree (canvas + accessible list) */}
      {data.nodes.length > 0 && (
        <OrgNodeSection
          data={data}
          density={density}
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
      {data.grants.length > 0 && <OrgGrantChainView grants={data.grants} />}

      {/* Budgets */}
      {data.budgets.length > 0 && (
        <OrgBudgetSection
          budgets={data.budgets}
          headingRef={budgetsHeadingRef}
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
      <OrgBudgetForm
        nodes={data.nodes}
        open={createBudgetOpen}
        onOpenChange={setCreateBudgetOpen}
      />
    </div>
  );
}

// ── Node tree section ─────────────────────────────────────────────────────

function OrgNodeSection({
  data,
  density,
  viewMode,
  selectedDtag,
  onSelectNode,
  onCreateChild,
}: {
  data: OrgChartType;
  density: CanvasDensity;
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

  const list = (
    <div className="space-y-0.5">
      {tree.roots.map((node) => (
        <OrgTreeNodeRow
          key={node.node.dtag}
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
            onSelect={onSelectNode}
            roots={tree.roots}
            selectedDtag={selectedDtag}
            summaryLabel={`Org chart: ${summary.nodeCount} nodes (${summary.roleCount} roles, ${summary.teamCount} teams, ${summary.agentSeatCount} agent seats) and ${summary.grantCount} active grants. Interactions are pointer-driven; the node list below the canvas is the accessible version of this chart.`}
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
  onClose,
  tree,
}: {
  data: OrgChartType;
  dtag: string;
  onClose: () => void;
  tree: ReturnType<typeof buildOrgTree>;
}) {
  const treeNode = tree.byDtag.get(dtag);
  if (!treeNode) return null;
  const node = treeNode.node;
  const occupants = [...node.holders, ...node.agentSeats];
  const occupantSet = new Set(occupants);
  const viaGrants = data.grants.filter((g) => !g.revoked && g.via === dtag);
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
              {occupants.map((pubkey) => (
                <PubKey key={pubkey} pubkey={pubkey} interactive={false} />
              ))}
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

function OccupantChips({ pubkeys }: { pubkeys: string[] }) {
  if (pubkeys.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
      {pubkeys.map((pubkey) => (
        <PubKey
          key={pubkey}
          pubkey={pubkey}
          interactive={false}
          className="text-xs text-muted-foreground"
        />
      ))}
    </div>
  );
}

function OrgTreeNodeRow({
  node,
  onCreateChild,
}: {
  node: OrgTreeNode;
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
          <OccupantChips pubkeys={occupants} />
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

// ── Budget section ────────────────────────────────────────────────────────

function OrgBudgetSection({
  budgets,
  headingRef,
}: {
  budgets: OrgBudget[];
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const deleteMutation = useDeleteOrgBudgetMutation();
  const activeBudgets = budgets.filter((b) => !b.revoked);

  if (activeBudgets.length === 0) return null;

  return (
    <div>
      <h3
        className="mb-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        ref={headingRef}
        tabIndex={-1}
      >
        Budgets
      </h3>
      <div className="space-y-2">
        {activeBudgets.map((budget) => {
          const limits = budget.limits;
          const limitText = [
            limits.runs && `${limits.runs} runs/${budget.window}`,
            limits.tasks?.create &&
              `${limits.tasks.create} tasks created/${budget.window}`,
            limits.tasks?.approve &&
              `${limits.tasks.approve} tasks approved/${budget.window}`,
            limits.spend &&
              `${limits.spend.amount} ${limits.spend.unit}/${budget.window}`,
          ]
            .filter(Boolean)
            .join(", ");

          return (
            <Card key={budget.dtag} className="group p-3 relative">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {budget.subject || budget.dtag}
                    </span>
                    {budget.onchain && (
                      <OnchainChip
                        address={budget.onchain.contract}
                        chain={budget.onchain.chain}
                        label={`Spend bound onchain on ${budget.onchain.chain} to ${budget.onchain.contract}`}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {limitText || "no limits"}
                    <span className="ml-2">
                      <AlertTriangle className="inline h-3 w-3" />
                      on exceed: {budget.onExceed}
                    </span>
                  </div>
                  <OrgBudgetConsumption budget={budget} />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label={`Budget actions for ${budget.subject || budget.dtag}`}
                      className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted"
                      type="button"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => deleteMutation.mutate(budget.dtag)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Metric row: budgets + needs attention ─────────────────────────────────

/**
 * Budgets metric card (count + worst utilization bar) and the needs-attention
 * card (budgets at/over 70% + unverifiable floor counts). Clicking
 * needs-attention scrolls to and focuses the budgets section — a real
 * affordance, never a fake navigation. Revoked events are filtered upstream
 * in hooks.ts before the chart sees them, so revoked anomalies are not
 * counted here; adding them needs a dedicated query, not a silent guess.
 */
function OrgBudgetMetricCards({
  budgets,
  onFocusBudgets,
}: {
  budgets: OrgBudget[];
  onFocusBudgets: () => void;
}) {
  const activeBudgets = React.useMemo(
    () => budgets.filter((b) => !b.revoked),
    [budgets],
  );
  const utilizations = useBudgetUtilizationsQuery(activeBudgets);
  const entries = utilizations.data ?? [];

  const inputs = entries.map((entry) => {
    if (!entry.summary) {
      return { flagged: false, percentage: null, truncated: false };
    }
    const { consumed, limit, truncated } = entry.summary;
    return {
      flagged: typeof limit === "number" && limit === 0 && consumed > 0,
      percentage: utilizationPercentage(consumed, limit),
      truncated,
    };
  });
  const { worstIndex, attentionCount } = summarizeUtilizations(inputs);

  const worst = worstIndex !== null ? entries[worstIndex] : undefined;
  const anyTruncated = entries.some((entry) => entry.summary?.truncated);
  const floorEntry = anyTruncated
    ? entries.find((entry) => entry.summary?.truncated)
    : undefined;

  const worstSummary = worst?.summary;
  const worstHasCeiling =
    typeof worstSummary?.limit === "number" && (worstSummary?.limit ?? 0) > 0;

  return (
    <>
      <MetricCard
        description={
          utilizations.isPending
            ? "checking usage…"
            : activeBudgets.length === 0
              ? undefined
              : worstSummary
                ? undefined
                : "no usage data"
        }
        label="Budgets"
        testId="org-metric-budgets"
        value={activeBudgets.length}
      >
        {worst && worstSummary && (
          <UtilizationBar
            caption={`worst of ${activeBudgets.length} budgets`}
            className="mt-1.5"
            consumed={worstSummary.consumed}
            label={`Worst budget utilization (${worst.budget.subject || worst.budget.dtag})`}
            limit={worstHasCeiling ? worstSummary.limit : null}
            readout={
              worstSummary.truncated
                ? undefined
                : worstHasCeiling
                  ? `${worstSummary.consumed} / ${worstSummary.limit} runs`
                  : `${worstSummary.consumed} runs`
            }
            truncated={worstSummary.truncated}
          />
        )}
        {!worst && floorEntry?.summary && (
          <UtilizationBar
            className="mt-1.5"
            consumed={floorEntry.summary.consumed}
            floor={METRIC_FETCH_LIMIT}
            label={`Budget usage floor (${floorEntry.budget.subject || floorEntry.budget.dtag})`}
            truncated
          />
        )}
      </MetricCard>
      <MetricCard
        description={
          activeBudgets.length === 0
            ? "no budgets to watch"
            : "budgets ≥70% · floor counts"
        }
        label="Needs attention"
        onClick={activeBudgets.length > 0 ? onFocusBudgets : undefined}
        testId="org-metric-needs-attention"
        value={attentionCount}
      />
    </>
  );
}
