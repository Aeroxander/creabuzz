import { useMemo } from "react";

import { listedProject } from "@/features/launchpad/lib/listing";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { effectiveStage } from "@/features/launchpad/models";
import { useLaunches } from "@/features/launchpad/use-launches";

/**
 * The projects this build lists, for Home's small summaries (the "Just started" strip, the update-day rail, the week in
 * review). Anything its founder removed is not in the records at all, and one set to "Not listed yet" is left out here.
 * `complete` says that every project and every update was read, so a count of them can be stated as it stands; the
 * strip needs only `newsFresh` (the newest updates were read, which is where a new project's first update would be).
 */
export function useListedLaunches() {
  const launches = useLaunches();
  const listed = useMemo(() => {
    if (!launches.data) return null;
    const raises = raisesOffered();
    return launches.data.filter((l) =>
      listedProject(l.record, effectiveStage(l), raises),
    );
  }, [launches.data]);
  return {
    listed,
    complete: !launches.hasMore && !launches.cut && !launches.newsCut,
    newsFresh: !launches.newsCut,
  };
}
