import { useOrgChartQuery, useContributionRecordsQuery } from "../hooks";
import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/ui/tabs";
import { OrgChart } from "./OrgChart";
import { ContributionRecordsTable } from "./ContributionRecordsTable";

function ContributionRecordsTab() {
  const query = useContributionRecordsQuery();

  if (query.isPending) {
    return (
      <EmptyState
        icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
        testId="contributions-loading"
        title="Loading contribution records…"
      />
    );
  }

  if (query.isError) {
    return (
      <EmptyState
        action={
          <Button onClick={() => query.refetch()} size="sm" variant="outline">
            Retry
          </Button>
        }
        description="The relay did not answer the contribution query. Check the connection, then retry."
        testId="contributions-error"
        title="Failed to load contribution records"
        variant="error"
      />
    );
  }

  return <ContributionRecordsTable records={query.data ?? []} />;
}

export function OrgView() {
  const query = useOrgChartQuery();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-3"
        data-tauri-drag-region
      >
        <h1 className="text-sm font-semibold" data-tauri-drag-region>
          Org Chart
        </h1>
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="chart">
        <div className="px-4 pt-2">
          <TabsList aria-label="Org views">
            <TabsTrigger data-testid="org-tab-chart" value="chart">
              Chart
            </TabsTrigger>
            <TabsTrigger
              data-testid="org-tab-contributions"
              value="contributions"
            >
              Contributions
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto" value="chart">
          <OrgChart query={query} />
        </TabsContent>
        <TabsContent
          className="min-h-0 flex-1 overflow-y-auto"
          value="contributions"
        >
          <ContributionRecordsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
