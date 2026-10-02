import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const SocialHomePage = lazyRouteComponent(
  () => import("@/features/social/ui/SocialHomePage"),
  "SocialHomePage",
);

export const Route = createFileRoute("/social")({
  component: SocialHomePage,
});
