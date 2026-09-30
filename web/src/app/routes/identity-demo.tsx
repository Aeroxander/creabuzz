import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/identity-demo")({
  component: lazyRouteComponent(
    () => import("@/features/identity/ui/PasskeyCeremonyPage"),
    "PasskeyCeremonyPage",
  ),
});
