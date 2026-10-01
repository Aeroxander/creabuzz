import { createFileRoute } from "@tanstack/react-router";
import { NotificationsPage } from "@/features/feed/ui/NotificationsPage";

export const Route = createFileRoute("/notifications")({
  component: NotificationsPage,
});
