import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { beyondContributorProjects } from "../lib/build-gates";

export const Route = createFileRoute("/repos/$repoId")({
  // Code browsing is not part of a contributor-only build: the address leads to the communities.
  beforeLoad: () => {
    if (!beyondContributorProjects())
      throw redirect({ to: "/c", replace: true });
  },
  component: lazyRouteComponent(
    () => import("@/features/repos/ui/RepoDetailPage"),
    "RepoDetailPage",
  ),
});
