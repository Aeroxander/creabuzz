import { createFileRoute } from "@tanstack/react-router";
import { CommunityHomePage } from "@/features/communities/ui/CommunityHomePage";

export const Route = createFileRoute("/c/$host")({
  component: CommunityHomePage,
});
