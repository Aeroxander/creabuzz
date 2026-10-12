import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { parseStart } from "@/features/start/lib/start-steps";

export const Route = createFileRoute("/launchpad")({
  // `?start=idea` or `?start=sale` opens that dialog: the Start page links straight to it.
  validateSearch: (
    search: Record<string, unknown>,
  ): { start?: "idea" | "sale" } => ({ start: parseStart(search.start) }),
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/LaunchesPage"),
    "LaunchesPage",
  ),
});
