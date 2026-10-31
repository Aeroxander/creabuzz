import {
  Outlet,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";

import { RecoveryOfferHost } from "@/features/identity/ui/RecoveryOfferHost";

import { AppNav, hidesAppNav } from "../AppNav";
import { MAIN_ID } from "../main-scroll";
import { NotFoundView, RouteErrorView } from "../BoundaryViews";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorView,
  notFoundComponent: NotFoundView,
});

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showNav = !hidesAppNav(pathname);
  return (
    <div className="flex h-dvh flex-col">
      {/* One nav element: first on wide screens (top bar), last on phones (tab bar). */}
      {showNav ? (
        <div className="relative z-20 order-last flex md:order-first">
          <AppNav />
        </div>
      ) : null}
      {/* The one scroll container for pages that have none of their own, so the nav (and the phone's tab bar) never
          scrolls away or paints over a page; pages with their own scroller fill it exactly. */}
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        id={MAIN_ID}
      >
        <Outlet />
      </main>
      {/* The recovery-key offer after a passkey sign-up: here, so no page's re-render can close it. */}
      <RecoveryOfferHost />
    </div>
  );
}
