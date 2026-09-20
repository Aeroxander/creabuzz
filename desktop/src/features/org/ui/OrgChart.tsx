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
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { PubKey } from "@/shared/ui/PubKey";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useDeleteOrgNodeMutation, useDeleteOrgBudgetMutation } from "../hooks";
import { buildOrgTree, orgChartSummary, type OrgTreeNode } from "../lib/tree";
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        Loading org chart...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-destructive">
        Failed to load org chart
      </div>
    );
  }

  if (
    !data ||
    (data.nodes.length === 0 &&
      data.grants.length === 0 &&
      data.budgets.length === 0)
  ) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-sm text-muted-foreground">
          No org data yet. Create your first role or team to get started.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setSelectedParentDtag(undefined);
            setCreateNodeOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Create First Node
        </Button>
      </div>
    );
  }

  const summary = orgChartSummary(data.nodes, data.grants, data.budgets);

  return (
    <div className="p-4 space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>{summary.nodeCount} nodes</span>
        <span>{summary.grantCount} grants</span>
        <span>{summary.budgetCount} budgets</span>
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

      {/* Node tree */}
      {data.nodes.length > 0 && (
        <OrgNodeSection
          data={data}
          onCreateChild={(parentDtag) => {
            setSelectedParentDtag(parentDtag);
            setCreateNodeOpen(true);
          }}
        />
      )}

      {/* Grants */}
      {data.grants.length > 0 && <OrgGrantChainView grants={data.grants} />}

      {/* Budgets */}
      {data.budgets.length > 0 && <OrgBudgetSection budgets={data.budgets} />}

      {/* Dialogs */}
      <OrgNodeForm
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
        open={createBudgetOpen}
        onOpenChange={setCreateBudgetOpen}
      />
    </div>
  );
}

// ── Node tree section ─────────────────────────────────────────────────────

function OrgNodeSection({
  data,
  onCreateChild,
}: {
  data: OrgChartType;
  onCreateChild: (parentDtag: string) => void;
}) {
  const tree = React.useMemo(() => buildOrgTree(data.nodes), [data.nodes]);

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Roles &amp; Teams</h3>
      <div className="space-y-0.5">
        {tree.roots.map((node) => (
          <OrgTreeNodeRow
            key={node.node.dtag}
            node={node}
            onCreateChild={onCreateChild}
          />
        ))}
      </div>
    </div>
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

function OrgBudgetSection({ budgets }: { budgets: OrgBudget[] }) {
  const deleteMutation = useDeleteOrgBudgetMutation();
  const activeBudgets = budgets.filter((b) => !b.revoked);

  if (activeBudgets.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Budgets</h3>
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
