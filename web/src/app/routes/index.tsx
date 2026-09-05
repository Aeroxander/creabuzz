import { createFileRoute } from "@tanstack/react-router";
import { CommunityDirectoryPage } from "@/features/communities/ui/CommunityDirectoryPage";
import { useCommunities } from "@/features/communities/use-communities";
import { ReposPage } from "@/features/repos/ui/ReposPage";

function DiscoveryLanding() {
  const { isError } = useCommunities();

  // Older relays without `GET /communities` fall back to the repo browser,
  // preserving the previous landing behavior.
  if (isError) {
    return <ReposPage />;
  }
  return <CommunityDirectoryPage />;
}

export const Route = createFileRoute("/")({
  component: DiscoveryLanding,
});
