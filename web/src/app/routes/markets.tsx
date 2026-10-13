import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/markets")({
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/MarketsPage"),
    "MarketsPage",
  ),
});
