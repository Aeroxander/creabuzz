import { createFileRoute } from "@tanstack/react-router";
import { FeedHomePage } from "@/features/feed/ui/FeedHomePage";

export const Route = createFileRoute("/feed")({
  component: FeedHomePage,
});
