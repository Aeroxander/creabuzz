import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const MessagesPage = lazyRouteComponent(
  () => import("@/features/social/ui/MessagesPage"),
  "MessagesPage",
);

export const Route = createFileRoute("/social/messages")({
  component: MessagesPage,
});
