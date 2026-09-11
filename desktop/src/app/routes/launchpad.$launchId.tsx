import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { LaunchDetailScreen } from "@/features/launchpad/ui/LaunchDetailScreen";
import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

export const Route = createFileRoute("/launchpad/$launchId")({
  validateSearch: (search: Record<string, unknown>) => ({
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
  }),
  component: LaunchDetailRouteComponent,
});

function LaunchDetailRouteComponent() {
  usePreviewFeatureWarning("launchpad");
  const { launchId } = Route.useParams();
  const { author } = Route.useSearch();
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="launchpad" />}>
      <LaunchDetailScreen launchId={launchId} author={author} />
    </React.Suspense>
  );
}
