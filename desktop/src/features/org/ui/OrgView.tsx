import { useOrgChartQuery } from "../hooks";
import { OrgChart } from "./OrgChart";

export function OrgView() {
  const query = useOrgChartQuery();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className="flex shrink-0 items-center border-b px-4 py-3"
        data-tauri-drag-region
      >
        <h1 className="text-sm font-semibold" data-tauri-drag-region>
          Org Chart
        </h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <OrgChart query={query} />
      </div>
    </div>
  );
}
