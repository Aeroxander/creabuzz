import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { parseStart } from "@/features/start/lib/start-steps";
import { notContributorOnlyBuild } from "../lib/build-gates";

export const Route = createFileRoute("/launchpad")({
  // `?start=idea` or `?start=sale` opens that dialog: the Start page links straight to it.
  validateSearch: (
    search: Record<string, unknown>,
  ): { start?: "idea" | "sale" } => ({ start: parseStart(search.start) }),
  // A contributor-only build lists its projects and ideas on Discover, so this second list (named for sales) leads there.
  // `?start=idea` goes along: Discover opens the idea dialog itself. (Keeping it here would not last: this page drops
  // the parameter once read, and that navigation would be redirected, closing the dialog.) A project's own page
  // (`/launchpad/<id>`) is another route and keeps working.
  beforeLoad: ({ search }) => {
    if (!notContributorOnlyBuild()) {
      throw redirect({
        to: "/discover",
        search: (search.start === "idea" ? { start: "idea" } : {}) as never,
        replace: true,
      });
    }
  },
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/LaunchesPage"),
    "LaunchesPage",
  ),
});
