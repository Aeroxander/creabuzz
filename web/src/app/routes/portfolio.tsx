import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/portfolio")({
  component: lazyRouteComponent(
    () => import("@/features/portfolio/ui/PortfolioPage"),
    "PortfolioPage",
  ),
});
