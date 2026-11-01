import { createBrowserHistory, createRouter } from "@tanstack/react-router";

import { installMainScrollRestoration, MAIN_ID } from "@/app/main-scroll";
import { routeTree } from "@/app/routeTree.gen";
import { RouteErrorView } from "@/app/BoundaryViews";

export const router = createRouter({
  routeTree,
  history: createBrowserHistory(),
  // Every page catches its own crash inside the layout, so the navigation stays and leads elsewhere; the root's own
  // boundary (routes/root.tsx) is left for a crash in the layout itself.
  defaultErrorComponent: RouteErrorView,
  scrollRestoration: true,
  // Pages scroll inside the root layout's <main>, not the window: a new page starts at its top as well, and Back
  // returns to where the person was (installMainScrollRestoration below).
  scrollToTopSelectors: [`#${MAIN_ID}`],
  getScrollRestorationKey: (location: { pathname: string }) =>
    location.pathname,
});

installMainScrollRestoration(router);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
