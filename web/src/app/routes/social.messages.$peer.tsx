import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const ConversationPage = lazyRouteComponent(
  () => import("@/features/social/ui/ConversationPage"),
  "ConversationPage",
);

export const Route = createFileRoute("/social/messages/$peer")({
  component: ConversationPage,
});
