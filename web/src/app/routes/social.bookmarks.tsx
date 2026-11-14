import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const BookmarksPage = lazyRouteComponent(
  () => import("@/features/social/ui/BookmarksPage"),
  "BookmarksPage",
);

export const Route = createFileRoute("/social/bookmarks")({
  component: BookmarksPage,
});
