import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { HomePage } from "../features/home/HomePage";
import { legacyScreensOn } from "../lib/legacy";
import { ProjectPage } from "../features/project/ProjectPage";
import { Shell } from "./Shell";

// Home and a project's page are in the first download; every other screen loads when it is first opened.
const SignUpPage = lazyRouteComponent(
  () => import("../features/account/SignUpPage"),
  "SignUpPage",
);
const ConversationPage = lazyRouteComponent(
  () => import("../features/messages/ConversationPage"),
  "ConversationPage",
);
// The earlier backers' page belongs to the old design: its route exists only with the legacy-screens flag.
const EarlierPage = lazyRouteComponent(
  () => import("../legacy/LegacyEarlier"),
  "default",
);
const MessagesPage = lazyRouteComponent(
  () => import("../features/messages/MessagesPage"),
  "MessagesPage",
);
const PostPage = lazyRouteComponent(
  () => import("../features/posts/PostPage"),
  "PostPage",
);
const ProfilePage = lazyRouteComponent(
  () => import("../features/profile/ProfilePage"),
  "ProfilePage",
);
const SeasonPage = lazyRouteComponent(
  () => import("../features/season/SeasonPage"),
  "SeasonPage",
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
  validateSearch: (search: Record<string, unknown>): { tab?: "money" } =>
    search.tab === "money" ? { tab: "money" } : {},
  component: function ProjectRoute() {
    const { ref } = project.useParams();
    const { tab } = project.useSearch();
    return <ProjectPage key={ref} projectRef={ref} initialTab={tab} />;
  },
});

/** web/'s older project address (`/launchpad/<id>?author=<founder>`) opens the same page. */
const legacyProject = createRoute({
  getParentRoute: () => root,
  path: "/launchpad/$id",
  validateSearch: (search: Record<string, unknown>) => ({
    author: typeof search.author === "string" ? search.author : undefined,
  }),
  component: function LegacyProjectRoute() {
    const { id } = legacyProject.useParams();
    const { author } = legacyProject.useSearch();
    const ref = `${id}-${(author ?? "").slice(0, 16)}`;
    return <ProjectPage key={ref} projectRef={ref} />;
  },
});

/** A season's page: the projects that entered, together, on demo day (and for good after). */
const season = createRoute({
  getParentRoute: () => root,
  path: "/season/$n",
  component: function SeasonRoute() {
    const { n } = season.useParams();
    // A number is 1 to 9999 with no leading zero, as the server's season records have it; anything else is no season.
    const number = /^[1-9][0-9]{0,3}$/.test(n) ? Number(n) : 0;
    return <SeasonPage key={number} number={number} />;
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
const earlier = createRoute({
  getParentRoute: () => root,
  path: "/earlier",
  component: EarlierPage,
});
const messages = createRoute({
  getParentRoute: () => root,
  path: "/you/messages",
  component: MessagesPage,
});
const conversation = createRoute({
  getParentRoute: () => root,
  path: "/you/messages/$peer",
  component: function ConversationRoute() {
    const { peer } = conversation.useParams();
    return <ConversationPage key={peer} peer={peer} />;
  },
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

/**
 * The app's router. With `legacy` off (the default) the earlier backers' route is not in the tree at all, so its address
 * shows the app's "not found" and its code is never loaded.
 */
export function createAppRouter(legacy: boolean = legacyScreensOn()) {
  const routeTree = root.addChildren([
    home,
    project,
    legacyProject,
    season,
    start,
    week,
    you,
    ...(legacy ? [earlier] : []),
    messages,
    conversation,
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
