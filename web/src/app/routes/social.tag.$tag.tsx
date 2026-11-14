import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const HashtagPage = lazyRouteComponent(
  () => import("@/features/social/ui/HashtagPage"),
  "HashtagPage",
);

export const Route = createFileRoute("/social/tag/$tag")({
  component: HashtagPage,
});
