import { useMemo } from "react";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import {
  presenceDotClassName,
  presenceLabel,
  PRESENCE_MAX_TRACKED,
} from "../lib/presence";
import { usePresence, usePresenceHeartbeat } from "../use-presence";

const MAX_SHOWN = 6;

function normalizePubkeys(pubkeys: readonly string[]): string[] {
  return [...new Set(pubkeys.map((pubkey) => pubkey.trim().toLowerCase()))]
    .filter(Boolean)
    .sort()
    .slice(0, PRESENCE_MAX_TRACKED);
}

/**
 * Who is here: avatars of the members currently online/away, each with the
 * desktop presence dot. Renders nothing when nobody is present or the relay
 * lacks presence support. Also owns the viewer's presence heartbeat, so it is
 * mounted wherever a conversation is shown.
 */
export function PresenceStrip({
  memberPubkeys,
}: {
  memberPubkeys: readonly string[];
}) {
  usePresenceHeartbeat();
  const tracked = useMemo(
    () => normalizePubkeys(memberPubkeys),
    [memberPubkeys],
  );
  const presence = usePresence(tracked);
  const active = useMemo(
    () =>
      tracked.filter(
        (pubkey) =>
          presence[pubkey] === "online" || presence[pubkey] === "away",
      ),
    [tracked, presence],
  );
  const profiles = useProfiles(active);

  if (active.length === 0) return null;

  const shown = active.slice(0, MAX_SHOWN);
  return (
    <div
      role="img"
      aria-label={`${active.length} ${active.length === 1 ? "person" : "people"} here`}
      className="flex items-center -space-x-1.5"
      data-testid="presence-strip"
    >
      {shown.map((pubkey) => {
        const status = presence[pubkey];
        const name = resolveUserName(profiles.data?.[pubkey], pubkey);
        return (
          <span
            key={pubkey}
            className="relative"
            title={`${name} — ${presenceLabel(status)}`}
          >
            <UserAvatar avatarUrl={null} displayName={name} size="xs" />
            <span
              aria-hidden="true"
              className={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-background ${presenceDotClassName(status)}`}
            />
          </span>
        );
      })}
      {active.length > shown.length ? (
        <span className="ml-2 text-2xs text-muted-foreground">
          {active.length - shown.length} more
        </span>
      ) : null}
    </div>
  );
}
