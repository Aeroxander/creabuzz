import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { HomePage } from "../features/home/HomePage";
import { Shell } from "./Shell";

// Home and a project's page are in the first download; every other screen loads when it is first opened.
// The project page is the biggest screen (its money, tasks and room are behind it): it loads when a project is opened, so
// Home, the first screen, stays within the first-load budget.
const ProjectPage = lazyRouteComponent(
  () => import("../features/project/ProjectPage"),
  "ProjectPage",
);
const SignUpPage = lazyRouteComponent(
  () => import("../features/account/SignUpPage"),
  "SignUpPage",
);
const StartPage = lazyRouteComponent(
  () => import("../features/start/StartPage"),
  "StartPage",
);
const WeekPage = lazyRouteComponent(
  () => import("../features/week/WeekPage"),
  "WeekPage",
);
const YouPage = lazyRouteComponent(
  () => import("../features/you/YouPage"),
  "YouPage",
);

const root = createRootRoute({ component: Shell });

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: HomePage,
});

const project = createRoute({
  getParentRoute: () => root,
  path: "/p/$ref",
  // `?tab=money` opens the Money tab (the news on You sends a holder there to take their money out).
  validateSearch: (search: Record<string, unknown>): { tab?: "money" } => ({
    ...(search.tab === "money" ? { tab: "money" as const } : {}),
  }),
  component: function ProjectRoute() {
    const { ref } = project.useParams();
    const { tab } = project.useSearch();
    return <ProjectPage initialTab={tab} key={ref} projectRef={ref} />;
  },
});

const start = createRoute({
  getParentRoute: () => root,
  path: "/start",
  component: StartPage,
});
const week = createRoute({
  getParentRoute: () => root,
  path: "/week",
  component: WeekPage,
});
const you = createRoute({
  getParentRoute: () => root,
  path: "/you",
  component: YouPage,
});
const welcome = createRoute({
  getParentRoute: () => root,
  path: "/welcome",
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string; mode?: "signin" } => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(search.mode === "signin" ? { mode: "signin" as const } : {}),
  }),
  component: function WelcomeRoute() {
    const { next, mode } = welcome.useSearch();
    return <SignUpPage mode={mode} next={next} />;
  },
});

/** The app's router. */
export function createAppRouter() {
  const routeTree = root.addChildren([
    home,
    project,
    start,
    week,
    you,
    welcome,
  ]);
  return createRouter({
    routeTree,
    defaultPreload: false,
    scrollRestoration: true,
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
