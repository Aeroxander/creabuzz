import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/launchpad")({
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/LaunchesPage"),
    "LaunchesPage",
  ),
});
