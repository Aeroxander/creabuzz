import {
  Outlet,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";

import { AppNav, hidesAppNav } from "../AppNav";
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
        <div className="order-last flex md:order-first">
          <AppNav />
        </div>
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
