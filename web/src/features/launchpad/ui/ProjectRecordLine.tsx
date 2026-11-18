/**
 * The project's record in one line of chips, under its name (`RecordLine`, `lib/record-line.ts`): how fresh it is, weeks
 * in a row, promises kept, and the work done. The page reads the same state its scorecard reads, so the two never say
 * different things. While it is being read nothing shows; a read that failed says so once and shows no number.
 */

import { acceptedByOthers, doneAlone } from "../lib/task-checks";
import type { Launch } from "../models";
import { useProjectState } from "../use-my-projects";
import { RecordLine } from "./RecordLine";

export function ProjectRecordLine({
  launch,
  viewerIsFounder,
  withLink = true,
}: {
  launch: Launch;
  viewerIsFounder: boolean;
  /** The one "See the full record" link. Left out where the page has the founder's next step in its place. */
  withLink?: boolean;
}) {
  const state = useProjectState(launch.record);
  const s = state.data;
  if (!s && !state.isError) return null;
  const tasksKnown = Boolean(s?.tasksKnown);
  return (
    <RecordLine
      input={{
        now: Math.floor(Date.now() / 1000),
        startedAt: launch.record.startedAt,
        lastUpdateAt: s?.lastUpdateAt ?? null,
        updatesKnown: Boolean(s?.updatesKnown),
        streak: s?.streak ?? null,
        promises: s?.promises ?? null,
        acceptedByOthers:
          s && tasksKnown ? acceptedByOthers(s.tasks).length : null,
        doneByFounder: s && tasksKnown ? doneAlone(s.tasks).length : null,
        viewerIsFounder,
      }}
      project={withLink ? launch.record : undefined}
    />
  );
}
