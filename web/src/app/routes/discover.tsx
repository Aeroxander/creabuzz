import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/discover")({
  component: lazyRouteComponent(
    () => import("@/features/discover/ui/DiscoverPage"),
    "DiscoverPage",
  ),
});
