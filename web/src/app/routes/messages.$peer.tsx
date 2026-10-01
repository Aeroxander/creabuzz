import { createFileRoute } from "@tanstack/react-router";
import { ConversationPage } from "@/features/messages/ui/ConversationPage";

export const Route = createFileRoute("/messages/$peer")({
  component: ConversationPage,
});
