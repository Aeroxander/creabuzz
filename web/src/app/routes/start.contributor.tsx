import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/start/contributor")({
  component: lazyRouteComponent(
    () => import("@/features/start/ui/ContributorStartPage"),
    "ContributorStartPage",
  ),
});
