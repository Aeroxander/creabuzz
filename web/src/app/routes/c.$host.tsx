import { createFileRoute } from "@tanstack/react-router";
import { CommunityHomePage } from "@/features/communities/ui/CommunityHomePage";

interface CommunitySearch {
  channel?: string;
}

export const Route = createFileRoute("/c/$host")({
  validateSearch: (search: Record<string, unknown>): CommunitySearch => ({
    channel: typeof search.channel === "string" ? search.channel : undefined,
  }),
  component: CommunityHomePage,
});
