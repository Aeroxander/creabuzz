import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { beyondContributorProjects } from "../lib/build-gates";

export const Route = createFileRoute("/projects")({
  // A contributor-only build lists projects on Discover; the old board would hand out Shares outside reviewed work.
  beforeLoad: () => {
    if (!beyondContributorProjects()) {
      throw redirect({ to: "/discover", replace: true });
    }
  },
  component: lazyRouteComponent(
    () => import("@/features/projects/ui/BoardPage"),
    "BoardPage",
  ),
});
