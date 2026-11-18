import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { notContributorOnlyBuild } from "../lib/build-gates";

/**
 * Repository list. The landing page links here, so it must render the same
 * browser the landing falls back to — a redirect made that button a dead end.
 * Loaded on demand: it carries the git client.
 */
export const Route = createFileRoute("/repos")({
  // Code browsing is not part of a contributor-only build: the address leads to the communities.
  beforeLoad: () => {
    if (!notContributorOnlyBuild()) throw redirect({ to: "/c", replace: true });
  },
  component: lazyRouteComponent(
    () => import("@/features/repos/ui/ReposPage"),
    "ReposPage",
  ),
});
