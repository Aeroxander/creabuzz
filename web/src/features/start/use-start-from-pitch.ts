/**
 * A team from the Projects board, ready to start as a contributor project (D84): the board's pitch and team, read and
 * turned into the Start page's form (`lib/from-pitch.ts`). Only the founder who wrote the pitch may start it.
 */

import { useMemo } from "react";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { useProject } from "@/features/projects/use-projects";
import { existingUserPubkey } from "@/shared/lib/identity";

import { draftFromPitch, type PitchStart } from "./lib/from-pitch";

export function useStartFromPitch(
  projectId: string | undefined,
  author: string | undefined,
): {
  /** Null when no board project was named, or it is not loaded yet. */
  start: PitchStart | null;
  isLoading: boolean;
  /** Why it cannot be used: not found, or the reader is not its founder. */
  problem: string | null;
} {
  const found = useProject(projectId ?? "", author);
  const project = projectId ? found.project : null;
  const holders = useMemo(
    () =>
      (project?.roles ?? []).flatMap((role) =>
        role.grant ? [role.grant.grantee] : [],
      ),
    [project],
  );
  const profileQuery = useProfiles(holders);
  const profiles = profileQuery.data;
  const me = existingUserPubkey();

  const start = useMemo(() => {
    if (!project) return null;
    const founderRole = project.roles.find((role) => role.isFounderRole);
    return draftFromPitch({
      name: project.manifest.name,
      summary: project.manifest.summary,
      founderPct: founderRole?.role.pct ?? 0,
      roles: project.roles
        .filter((role) => !role.isFounderRole)
        .map((role) => ({
          slug: role.role.slug,
          label: role.role.label,
          pct: role.role.pct,
          holder: role.grant
            ? resolveUserName(
                profiles?.[role.grant.grantee],
                role.grant.grantee,
              )
            : null,
        })),
    });
  }, [project, profiles]);

  if (!projectId) return { start: null, isLoading: false, problem: null };
  // Wait for the role holders' names too, so the form is filled once, with them.
  if (found.isLoading || (holders.length > 0 && profileQuery.isLoading))
    return { start: null, isLoading: true, problem: null };
  if (!project)
    return {
      start: null,
      isLoading: false,
      problem: "That project is not on the Projects board any more.",
    };
  if (me !== project.founder)
    return {
      start: null,
      isLoading: false,
      problem: "Only the person who posted the project can start it.",
    };
  return { start, isLoading: false, problem: null };
}
