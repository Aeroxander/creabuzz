import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import { latestProjects } from "../project/project-record";

/** How many projects Home reads: enough to fill a phone screen several times. */
const PROJECTS_READ = 60;

/**
 * Projects for Home, newest activity first (a record is re-signed whenever its founder changes it). Never ordered by
 * money raised (plan section 6). Unlisted projects are left out.
 */
export function useHomeProjects() {
  return useQuery({
    queryKey: ["home", "projects"],
    staleTime: 30_000,
    queryFn: async () =>
      latestProjects(
        await read({ kinds: [KIND_LAUNCH_RECORD], limit: PROJECTS_READ }),
      ).filter((project) => !project.unlisted),
  });
}
