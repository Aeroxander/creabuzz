import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import {
  type EarlierGrantSettings,
  earlierGrantSettings,
} from "../features/earlier-grant/earlier-grant-settings";
import { HomePage } from "../features/home/HomePage";
import { legacyScreensOn } from "../lib/legacy";
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
const ConversationPage = lazyRouteComponent(
  () => import("../features/messages/ConversationPage"),
  "ConversationPage",
);
// The earlier backers' page belongs to the old design: its route exists only with the legacy-screens flag.
const EarlierGrantPage = lazyRouteComponent(
  () => import("../features/earlier-grant/EarlierGrantPage"),
  "EarlierGrantPage",
);
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
  // `?brain=setup` opens the steps for keeping a project brain (a founder who said yes to it in Start).
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: "money"; brain?: "setup" } => ({
    ...(search.tab === "money" ? { tab: "money" as const } : {}),
    ...(search.brain === "setup" ? { brain: "setup" as const } : {}),
  }),
  component: function ProjectRoute() {
    const { ref } = project.useParams();
    const { tab, brain } = project.useSearch();
    return (
      <ProjectPage
        brainSetup={brain === "setup"}
        initialTab={tab}
        key={ref}
        projectRef={ref}
      />
    );
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
/**
 * The earlier backers' claim page (step 4): its route is in the tree only for a build given its three settings, so without them
 * its address is the app's plain "not found" and no code of the page is ever loaded.
 */
function earlierGrantRoute(settings: EarlierGrantSettings) {
  return createRoute({
    getParentRoute: () => root,
    path: "/earlier-grant",
    component: function EarlierGrantRoute() {
      return <EarlierGrantPage settings={settings} />;
    },
  });
}
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

/**
 * The app's router. With `legacy` off (the default) the earlier backers' route is not in the tree at all, so its address
 * shows the app's "not found" and its code is never loaded.
 */
export function createAppRouter(
  legacy: boolean = legacyScreensOn(),
  earlierGrant: EarlierGrantSettings | null = earlierGrantSettings(),
) {
  const routeTree = root.addChildren([
    home,
    project,
    legacyProject,
    season,
    start,
    week,
    you,
    ...(legacy ? [earlier] : []),
    ...(earlierGrant ? [earlierGrantRoute(earlierGrant)] : []),
    messages,
    conversation,
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
