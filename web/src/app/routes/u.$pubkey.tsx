import {
  createFileRoute,
  lazyRouteComponent,
  Navigate,
} from "@tanstack/react-router";

import { existingUserPubkey } from "@/shared/lib/identity";

import { resolveProfileParam } from "../lib/profile-param";

const ProfilePage = lazyRouteComponent(
  () => import("@/features/feed/ui/ProfilePage"),
  "ProfilePage",
);
const ProfileMissing = lazyRouteComponent(
  () => import("@/features/feed/ui/ProfilePage"),
  "ProfileMissing",
);

export const Route = createFileRoute("/u/$pubkey")({
  component: ProfileRoute,
});

function ProfileRoute() {
  const { pubkey } = Route.useParams();
  const target = resolveProfileParam(pubkey, existingUserPubkey());
  if (target.kind !== "person") {
    return <ProfileMissing signedOut={target.kind === "signed-out"} />;
  }
  if (!target.canonical) {
    return (
      <Navigate params={{ pubkey: target.pubkey }} replace to="/u/$pubkey" />
    );
  }
  return <ProfilePage pubkey={target.pubkey} />;
}
