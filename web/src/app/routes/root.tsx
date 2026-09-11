import { Outlet, createRootRoute } from "@tanstack/react-router";

import { NotFoundView, RouteErrorView } from "../BoundaryViews";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorView,
  notFoundComponent: NotFoundView,
});

function RootLayout() {
  return (
    <div className="flex h-dvh flex-col">
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
