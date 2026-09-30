import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const WikiView = React.lazy(async () => {
  const module = await import("@/features/wiki/ui/WikiView");
  return { default: module.WikiView };
});

export const Route = createFileRoute("/wiki")({
  component: WikiRouteComponent,
});

function WikiRouteComponent() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="wiki" />}>
      <WikiView />
    </React.Suspense>
  );
}
