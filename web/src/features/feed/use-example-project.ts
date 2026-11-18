import { useMemo } from "react";

import { useCommunityPeople } from "@/features/communities/use-access";

import { exampleProject } from "./lib/example-project";
import { useListedLaunches } from "./use-listed-launches";

/**
 * The server's own example project (`lib/example-project.ts`): the listed project its owner started, found through the
 * owner the server's member list names. Null while either read is pending, when the list cannot be read (a signed-out
 * visitor to an invite-only server cannot read it), or when the owner has no listed project: then nothing is offered.
 */
export function useExampleProject() {
  const { people } = useCommunityPeople();
  const { listed } = useListedLaunches();
  const owner =
    people.find((person) => person.role === "owner")?.pubkey ?? null;
  return useMemo(
    () => (listed ? exampleProject(listed, owner) : null),
    [listed, owner],
  );
}
