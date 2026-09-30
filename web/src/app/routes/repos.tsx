import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

/**
 * Repository list. The landing page links here, so it must render the same
 * browser the landing falls back to — a redirect made that button a dead end.
 * Loaded on demand: it carries the git client.
 */
export const Route = createFileRoute("/repos")({
  component: lazyRouteComponent(
    () => import("@/features/repos/ui/ReposPage"),
    "ReposPage",
  ),
});
