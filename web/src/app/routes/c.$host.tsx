import { createFileRoute } from "@tanstack/react-router";
import { CommunityHomePage } from "@/features/communities/ui/CommunityHomePage";

interface CommunitySearch {
  channel?: string;
  /** Message permalink target: the row is scrolled to and highlighted. */
  message?: string;
}

export const Route = createFileRoute("/c/$host")({
  validateSearch: (search: Record<string, unknown>): CommunitySearch => ({
    channel: typeof search.channel === "string" ? search.channel : undefined,
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  component: CommunityHomePage,
});
