import * as React from "react";
import {
  AlertTriangle,
  DollarSign,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { EmptyState } from "@/shared/ui/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useDeleteOrgBudgetMutation } from "../hooks";
import {
  budgetSubjectLabel,
  describeBudgetLimits,
  isCommunityDefaultSubject,
} from "../lib/budgetForm";
import type {
  OrgNode,
  OrgBudget,
  OrgChart as OrgChartType,
} from "../orgModels";
import type { UseQueryResult } from "@tanstack/react-query";
import { OrgBudgetForm } from "./OrgBudgetForm";
import { OrgBudgetConsumption } from "./OrgBudgetConsumption";
import { OrgBudgetLadder } from "./OrgBudgetLadder";
import { OnchainChip } from "./OnchainChip";

/**
 * Budgets tab: every active budget with its limits, the enforced-vs-advisory
 * badges, live consumption, and the create flow. Budgets are their own tab —
 * they are community-level policy (spend ceilings and their honesty labels),
 * not a footnote of one node in the chart.
 */
export function OrgBudgetsView({
  query,
  focusKey,
}: {
  query: UseQueryResult<OrgChartType, Error>;
  /** Bump to scroll the budgets heading into view (audit deep links). */
  focusKey?: number;
}) {
  const [createBudgetOpen, setCreateBudgetOpen] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (!focusKey) return;
    headingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  const { data, isLoading, error } = query;
  const budgets = data?.budgets ?? [];
  const activeBudgets = React.useMemo(
    () => budgets.filter((b) => !b.revoked),
    [budgets],
  );

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3
          className="text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          ref={headingRef}
          tabIndex={-1}
        >
          Budgets
        </h3>
        <Button
          data-testid="org-budget-create"
          onClick={() => setCreateBudgetOpen(true)}
          size="sm"
          variant="outline"
        >
          <Plus className="mr-1 h-3 w-3" />
          Budget
        </Button>
      </div>
      {isLoading ? (
        <EmptyState
          description="Loading budgets…"
          testId="org-budgets-loading"
          title="Loading budgets…"
        />
      ) : error ? (
        <EmptyState
          action={
            <Button onClick={() => query.refetch()} size="sm" variant="outline">
              Retry
            </Button>
          }
          description="The server did not answer the budget query. Check the connection, then retry."
          testId="org-budgets-error"
          title="Failed to load budgets"
          variant="error"
        />
      ) : activeBudgets.length === 0 ? (
        <EmptyState
          description="No budgets yet. Create one to cap an agent's runs, messages, or spend."
          testId="org-budgets-empty"
          title="No budgets yet"
        />
      ) : (
        <OrgBudgetSection budgets={budgets} nodes={data?.nodes ?? []} />
      )}
      <OrgBudgetForm
        nodes={data?.nodes ?? []}
        onOpenChange={setCreateBudgetOpen}
        open={createBudgetOpen}
      />
    </div>
  );
}

function OrgBudgetSection({
  budgets,
  nodes,
}: {
  budgets: OrgBudget[];
  nodes: OrgNode[];
}) {
  const deleteMutation = useDeleteOrgBudgetMutation();
  const activeBudgets = React.useMemo(
    () => budgets.filter((b) => !b.revoked),
    [budgets],
  );
  // A budget's subject is an agent pubkey (or "*"): name it from the agent's
  // profile, falling back to the seat it occupies, never the raw 64-hex key.
  const agentKeys = React.useMemo(
    () =>
      activeBudgets
        .filter((b) => b.subject && !isCommunityDefaultSubject(b.subject))
        .map((b) => b.subject),
    [activeBudgets],
  );
  const profiles = useUsersBatchQuery(agentKeys).data?.profiles;
  const seatNames = React.useMemo(() => {
    const names = new Map<string, string>();
    for (const node of nodes) {
      for (const seat of node.agentSeats) {
        const key = seat.trim().toLowerCase();
        if (!names.has(key)) names.set(key, node.name);
      }
    }
    return names;
  }, [nodes]);
  const subjectName = (budget: OrgBudget): string =>
    budget.subject
      ? budgetSubjectLabel(budget.subject, (pubkey) =>
          resolveUserLabel({
            pubkey,
            profiles,
            fallbackName: seatNames.get(pubkey.trim().toLowerCase()),
          }),
        )
      : budget.dtag;

  if (activeBudgets.length === 0) return null;

  return (
    <div>
      <div className="space-y-2">
        {activeBudgets.map((budget) => {
          const limitRows = describeBudgetLimits(budget);
          const name = subjectName(budget);

          return (
            <Card key={budget.dtag} className="group p-3 relative">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{name}</span>
                    {budget.onchain && (
                      <OnchainChip
                        address={budget.onchain.contract}
                        chain={budget.onchain.chain}
                        label={`Spend bound onchain on ${budget.onchain.chain} to ${budget.onchain.contract}`}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {limitRows.length > 0 ? (
                      <ul
                        className="space-y-0.5"
                        data-testid={`org-budget-limits-${budget.dtag}`}
                      >
                        {limitRows.map((row) => (
                          <li
                            className="flex flex-wrap items-center gap-1.5"
                            key={row.key}
                          >
                            <span>{row.text}</span>
                            <span
                              className="rounded-sm bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground"
                              data-enforcement={row.enforcement}
                            >
                              {row.badge}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      "no limits"
                    )}
                    <span className="mt-0.5 block">
                      <AlertTriangle className="inline h-3 w-3" />
                      on exceed: {budget.onExceed}
                    </span>
                  </div>
                  {isCommunityDefaultSubject(budget.subject) ? (
                    <p className="mt-1.5 text-2xs text-muted-foreground">
                      Applies to each agent that has no budget of its own; usage
                      is tracked per agent.
                    </p>
                  ) : (
                    <OrgBudgetConsumption budget={budget} />
                  )}
                  <OrgBudgetLadder budget={budget} />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label={`Budget actions for ${name}`}
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
