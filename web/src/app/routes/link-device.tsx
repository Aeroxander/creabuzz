import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/link-device")({
  component: lazyRouteComponent(
    () => import("@/features/identity/ui/LinkDevicePage"),
    "LinkDevicePage",
  ),
});
