import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

import { CommunityDirectoryPage } from "@/features/communities/ui/CommunityDirectoryPage";
import { useCommunities } from "@/features/communities/use-communities";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

// Only reached when the relay has no directory endpoint, and it pulls the git
// client — keep it out of the first-load bundle.
const ReposPage = lazy(() =>
  import("@/features/repos/ui/ReposPage").then((m) => ({
    default: m.ReposPage,
  })),
);

function DiscoveryLanding() {
  const { isError } = useCommunities();

  // Older relays without `GET /communities` fall back to the repo browser,
  // preserving the previous landing behavior.
  if (isError) {
    return (
      <Suspense
        fallback={<ViewLoadingFallback label="Loading repositories…" />}
      >
        <ReposPage />
      </Suspense>
    );
  }
  return <CommunityDirectoryPage />;
}

export const Route = createFileRoute("/")({
  component: DiscoveryLanding,
});
