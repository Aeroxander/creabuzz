import { createFileRoute } from "@tanstack/react-router";
import { BookmarksPage } from "@/features/feed/ui/BookmarksPage";

export const Route = createFileRoute("/bookmarks")({
  component: BookmarksPage,
});
