import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "@/features/feed/ui/ProfilePage";

export const Route = createFileRoute("/p/$id")({
  component: ProfilePage,
});
