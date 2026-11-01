import { createFileRoute, redirect } from "@tanstack/react-router";

import { notContributorOnlyBuild } from "../lib/build-gates";
import { RepoBlobPage } from "@/features/repos/ui/RepoBlobViewer";

export const Route = createFileRoute("/repos/$repoId/blob/$")({
  beforeLoad: () => {
    if (!notContributorOnlyBuild()) throw redirect({ to: "/c", replace: true });
  },
  component: RepoBlobPage,
});
