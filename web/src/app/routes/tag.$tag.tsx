import { createFileRoute } from "@tanstack/react-router";
import { HashtagPage } from "@/features/feed/ui/HashtagPage";

export const Route = createFileRoute("/tag/$tag")({
  component: HashtagPage,
});
