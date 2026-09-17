import { useUserNames } from "@/features/profiles/use-profiles";

import { PubkeyAvatar } from "./PubkeyAvatar";

/**
 * The avatar row for a set of people.
 *
 * It owns the surface's single kind-0 lookup, so a row of avatars costs one
 * batched query and every avatar still shows a username. Callers pass the
 * pubkeys they are about to render — a repository owner and its contributors,
 * an organisation's sidebar — and get named avatars; `PubkeyAvatar` itself
 * stays presentational, because it renders inside lists.
 */
export function PeopleAvatars({ pubkeys }: { pubkeys: string[] }) {
  const userNames = useUserNames(pubkeys);

  return (
    <>
      {pubkeys.map((pubkey) => (
        <PubkeyAvatar key={pubkey} pubkey={pubkey} name={userNames(pubkey)} />
      ))}
    </>
  );
}
