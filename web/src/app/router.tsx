import { createBrowserHistory, createRouter } from "@tanstack/react-router";

import { installMainScrollRestoration, MAIN_ID } from "@/app/main-scroll";
import { routeTree } from "@/app/routeTree.gen";

export const router = createRouter({
  routeTree,
  history: createBrowserHistory(),
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
