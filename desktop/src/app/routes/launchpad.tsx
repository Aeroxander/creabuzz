import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const LaunchpadScreen = React.lazy(async () => {
  const module = await import("@/features/launchpad/ui/LaunchpadScreen");
  return { default: module.LaunchpadScreen };
});

export const Route = createFileRoute("/launchpad")({
  component: LaunchpadRouteComponent,
});

function LaunchpadRouteComponent() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="launchpad" />}>
      <LaunchpadScreen />
    </React.Suspense>
  );
}
