import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useState } from "react";
import type { Profile } from "../feed-model";

export function pubkeyToHue(hex: string): number {
  let hash = 0;
  for (let i = 0; i < hex.length; i++) {
    hash = (hash * 31 + hex.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function displayNameOf(pubkey: string, profile?: Profile): string {
  return profile?.displayName ?? profile?.name ?? truncatePubkey(pubkey);
}

/** Round avatar: profile picture when it loads, otherwise a pubkey-tinted initial. */
export function Avatar({
  pubkey,
  profile,
  className,
}: {
  pubkey: string;
  profile?: Profile;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = cn("h-10 w-10 shrink-0 rounded-full", className);

  if (profile?.picture && !failed) {
    return (
      <img
        src={profile.picture}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn(base, "bg-muted object-cover")}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        base,
        "flex items-center justify-center font-semibold text-white",
      )}
      style={{ backgroundColor: `hsl(${pubkeyToHue(pubkey)}, 55%, 45%)` }}
    >
      {displayNameOf(pubkey, profile).slice(0, 1).toUpperCase()}
    </div>
  );
}
