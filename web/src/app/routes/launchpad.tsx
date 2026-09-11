import { createFileRoute } from "@tanstack/react-router";
import { LaunchesPage } from "@/features/launchpad/ui/LaunchesPage";

export const Route = createFileRoute("/launchpad")({
  component: LaunchesPage,
});
