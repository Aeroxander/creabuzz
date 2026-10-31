/**
 * The published titles of a DAO's work areas, keyed by short name (see `knownTitles`): one source, so the Work tab and
 * Contributions call a work area the same thing. Reads the same cached work and suggestion queries the Work tab does.
 */
import { useMemo } from "react";

import { knownTitles } from "./lib/work-titles";
import type { WorkSnapshot } from "./lib/work-read";
import { useWorkProposals } from "./use-work-proposals";

export function useWorkTitles(
  chainId: string | null,
  dao: string,
  work: WorkSnapshot | undefined,
): ReadonlyMap<string, string> {
  const approved = useMemo(
    () =>
      (work?.mandates ?? []).flatMap((m) =>
        m.projects.map((p) => ({
          projectId: p.approved.projectId,
          checkHash: p.approved.checkHash,
        })),
      ),
    [work],
  );
  const proposals = useWorkProposals(chainId, dao, approved);
  return useMemo(
    () => knownTitles(proposals.rows, approved),
    [proposals.rows, approved],
  );
}
