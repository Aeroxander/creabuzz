import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/court")({
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/CourtPage"),
    "CourtPage",
  ),
});
