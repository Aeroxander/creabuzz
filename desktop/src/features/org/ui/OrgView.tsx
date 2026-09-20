import { useOrgChartQuery, useContributionRecordsQuery } from "../hooks";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/ui/tabs";
import { OrgChart } from "./OrgChart";
import { ContributionRecordsTable } from "./ContributionRecordsTable";

function ContributionRecordsTab() {
  const query = useContributionRecordsQuery();

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        Loading contribution records...
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-destructive">
        Failed to load contribution records
      </div>
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
