import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { notContributorOnlyBuild } from "../lib/build-gates";

export const Route = createFileRoute("/repos/$repoId/blob/$")({
  beforeLoad: () => {
    if (!notContributorOnlyBuild()) throw redirect({ to: "/c", replace: true });
  },
  // The file viewer pulls in the git client (isomorphic-git, pako); load it with the page.
  component: lazyRouteComponent(
    () => import("@/features/repos/ui/RepoBlobViewer"),
    "RepoBlobPage",
  ),
});
