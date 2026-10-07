import { createFileRoute } from "@tanstack/react-router";
import { CommunityDirectoryPage } from "@/features/communities/ui/CommunityDirectoryPage";

export const Route = createFileRoute("/c")({
  component: CommunityDirectoryPage,
});
