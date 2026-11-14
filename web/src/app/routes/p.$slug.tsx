import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

/** A project's public scorecard: readable signed out, made to be shared. */
export const Route = createFileRoute("/p/$slug")({
  component: lazyRouteComponent(
    () => import("@/features/scorecard/ui/ScorecardPage"),
    "ScorecardPage",
  ),
});
