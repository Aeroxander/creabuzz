import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/work")({
  component: lazyRouteComponent(
    () => import("@/features/work/ui/WorkPage"),
    "WorkPage",
  ),
});
