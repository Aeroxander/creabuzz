import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The feed lives on Home. This address keeps working for old links and bookmarks; every other page of the social section
 * (`/social/explore`, `/social/notifications`, ...) is its own route and is unchanged.
 */
export const Route = createFileRoute("/social")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
