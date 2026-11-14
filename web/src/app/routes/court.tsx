import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { courtOffered } from "../lib/build-gates";

export const Route = createFileRoute("/court")({
  // The court lives on a test network; a build whose chain names none leads home instead of an empty court.
  beforeLoad: () => {
    if (!courtOffered()) throw redirect({ to: "/", replace: true });
  },
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/CourtPage"),
    "CourtPage",
  ),
});
