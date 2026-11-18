import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/start")({
  component: lazyRouteComponent(
    () => import("@/features/start/ui/StartPage"),
    "StartPage",
  ),
});
