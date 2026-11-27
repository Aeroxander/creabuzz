import { nameOf, useProfiles } from "../../lib/profiles";
import { Avatar } from "../../ui/avatar";

/** The head of a profile: picture, name, about. The name is the screen's h1 unless the screen has its own. */
export function ProfileHead({
  pubkey,
  level = "h1",
}: {
  pubkey: string;
  level?: "h1" | "h2";
}) {
  const Heading = level;
  const profiles = useProfiles([pubkey]).data;
  const name = nameOf(profiles, pubkey);
  const about = profiles?.[pubkey]?.about?.trim();
  return (
    <div className="flex items-center gap-4" data-testid="profile-head">
      <Avatar name={name} pubkey={pubkey} size="lg" />
      <div className="min-w-0">
        <Heading className="headline truncate text-2xl">{name}</Heading>
        {about ? (
          <p className="mt-1 line-clamp-3 text-sm text-muted">{about}</p>
        ) : null}
      </div>
    </div>
  );
}
