import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { raisesOffered } from "@/features/launchpad/lib/raises-offered";

export const Route = createFileRoute("/markets")({
  // Markets price what sales sold; a contributor-only build has none, so the address leads to Discover.
  beforeLoad: () => {
    if (!raisesOffered()) throw redirect({ to: "/discover", replace: true });
  },
  component: lazyRouteComponent(
    () => import("@/features/launchpad/ui/MarketsPage"),
    "MarketsPage",
  ),
});
