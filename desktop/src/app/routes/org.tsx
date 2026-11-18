import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const OrgView = React.lazy(async () => {
  const module = await import("@/features/org/ui/OrgView");
  return { default: module.OrgView };
});

function OrgRoute() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="org" />}>
      <OrgView />
    </React.Suspense>
  );
}

export const Route = createFileRoute("/org")({
  component: OrgRouteComponent,
});

function OrgRouteComponent() {
  return <OrgRoute />;
}
