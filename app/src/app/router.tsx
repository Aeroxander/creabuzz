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
const PostPage = lazyRouteComponent(
  () => import("../features/posts/PostPage"),
  "PostPage",
);
const ProfilePage = lazyRouteComponent(
  () => import("../features/profile/ProfilePage"),
  "ProfilePage",
);
const SavedPage = lazyRouteComponent(
  () => import("../features/saved/SavedPage"),
  "SavedPage",
);
const SearchPage = lazyRouteComponent(
  () => import("../features/search/SearchPage"),
  "SearchPage",
);
const TopicPage = lazyRouteComponent(
  () => import("../features/tags/TopicPage"),
  "TopicPage",
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
/** Search; the words typed are kept in the address (`?q=`), so Back returns to the same results. */
const search = createRoute({
  getParentRoute: () => root,
  path: "/search",
  validateSearch: (s: Record<string, unknown>): { q?: string } =>
    typeof s.q === "string" && s.q !== "" ? { q: s.q.slice(0, 100) } : {},
  component: function SearchRoute() {
    const { q } = search.useSearch();
    return <SearchPage q={q ?? ""} />;
  },
});
/** Every post under one topic (`#lamps`). */
const topic = createRoute({
  getParentRoute: () => root,
  path: "/tag/$tag",
  component: function TopicRoute() {
    const { tag } = topic.useParams();
    return <TopicPage key={tag} tag={tag} />;
  },
});
/** The posts this person saved. */
const saved = createRoute({
  getParentRoute: () => root,
  path: "/you/saved",
  component: SavedPage,
});
const post = createRoute({
  getParentRoute: () => root,
  path: "/post/$id",
  component: function PostRoute() {
    const { id } = post.useParams();
    return <PostPage id={id} key={id} />;
  },
});
const person = createRoute({
  getParentRoute: () => root,
  path: "/u/$pubkey",
  component: function PersonRoute() {
    const { pubkey } = person.useParams();
    return <ProfilePage key={pubkey} pubkey={pubkey} />;
  },
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
    saved,
    search,
    topic,
    post,
    person,
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
