import { createFileRoute } from "@tanstack/react-router";

import { ReposPage } from "@/features/repos/ui/ReposPage";

/**
 * Repository list. The landing page links here, so it must render the same
 * browser the landing falls back to — a redirect made that button a dead end.
 */
export const Route = createFileRoute("/repos")({
  component: ReposPage,
});
