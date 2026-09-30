import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const ProfilePage = lazyRouteComponent(
  () => import("@/features/feed/ui/ProfilePage"),
  "ProfilePage",
);

export const Route = createFileRoute("/u/$pubkey")({
  component: ProfileRoute,
});

function ProfileRoute() {
  const { pubkey } = Route.useParams();
  return <ProfilePage pubkey={pubkey.toLowerCase()} />;
}
