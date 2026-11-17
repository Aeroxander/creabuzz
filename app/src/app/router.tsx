import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { HomePage } from "../features/home/HomePage";
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
  component: function ProjectRoute() {
    const { ref } = project.useParams();
    return <ProjectPage key={ref} projectRef={ref} />;
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

const routeTree = root.addChildren([
  home,
  project,
  legacyProject,
  start,
  week,
  you,
  messages,
  conversation,
  post,
  person,
  welcome,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
