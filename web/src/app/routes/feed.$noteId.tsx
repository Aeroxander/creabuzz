import { createFileRoute } from "@tanstack/react-router";
import { ThreadPage } from "@/features/feed/ui/ThreadPage";

export const Route = createFileRoute("/feed/$noteId")({
  component: ThreadPage,
});
