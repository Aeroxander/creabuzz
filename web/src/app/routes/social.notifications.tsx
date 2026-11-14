import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const NotificationsPage = lazyRouteComponent(
  () => import("@/features/social/ui/NotificationsPage"),
  "NotificationsPage",
);

export const Route = createFileRoute("/social/notifications")({
  component: NotificationsPage,
});
