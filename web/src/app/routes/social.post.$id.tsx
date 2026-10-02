import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const ThreadPage = lazyRouteComponent(
  () => import("@/features/social/ui/ThreadPage"),
  "ThreadPage",
);

export const Route = createFileRoute("/social/post/$id")({
  component: ThreadPage,
});
