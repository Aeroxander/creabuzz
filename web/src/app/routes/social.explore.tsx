import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const ExplorePage = lazyRouteComponent(
  () => import("@/features/social/ui/ExplorePage"),
  "ExplorePage",
);

export const Route = createFileRoute("/social/explore")({
  component: ExplorePage,
});
