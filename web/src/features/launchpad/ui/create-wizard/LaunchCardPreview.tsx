/**
 * "This is how it will look": the card Discover and Launches will show for this
 * launch, filled live from the form. Inert, so nothing in it can be clicked
 * away from the dialog.
 */

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { LaunchCard } from "../LaunchCard";

export function LaunchCardPreview({
  name,
  pitch,
  image,
  category,
}: {
  name: string;
  pitch: string;
  image: string;
  category: string;
}) {
  const me = existingUserPubkey() ?? "";
  const { data: profiles } = useProfiles(me ? [me] : []);
  const profile = profiles?.[me];
  return (
    <div data-testid="launch-card-preview">
      <p className="mb-1.5 text-sm font-medium">How it looks on Discover</p>
      <div aria-hidden className="pointer-events-none max-w-xs" inert>
        <LaunchCard
          bids={0}
          followed={false}
          founder={{
            name: me ? resolveUserName(profile, me) : "You",
            picture: profile?.picture ?? null,
          }}
          onToggleFollow={() => undefined}
          record={{
            id: name.trim().toLowerCase().replace(/\s+/g, "-") || "your-launch",
            name: name.trim() || "Your launch",
            pitch: pitch.trim(),
            image: image.trim() || null,
            category: category || null,
            agent: null,
            author: me,
            currency: null,
            chainId: null,
            requiredRaised: null,
          }}
          stage="draft"
          updates={0}
        />
      </div>
    </div>
  );
}
