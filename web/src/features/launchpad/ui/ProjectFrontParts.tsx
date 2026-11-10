/**
 * Two small parts of the project page that read the project's own records, kept out of the page so it can use them
 * after it knows which project it shows.
 */

import { useEffect, useMemo } from "react";

import type { LaunchTab, TabUse } from "../lib/launch-tabs";
import { duePromises } from "../lib/promises";
import type { UpdateDraft } from "../lib/weekly-update";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";
import { useTabUses } from "../use-tab-uses";
import { PostUpdateDialog } from "./PostUpdateDialog";

/** Tells the page which of its shown-when-used tabs this project uses. Shows nothing. */
export function TabUsesProbe({
  launch,
  onUses,
}: {
  launch: Launch;
  onUses: (uses: Partial<Record<LaunchTab, TabUse>>) => void;
}) {
  const { updates, boards, agents } = useTabUses(launch);
  useEffect(() => {
    onUses({ updates, boards, agents });
  }, [updates, boards, agents, onUses]);
  return null;
}

/** The update dialog, with the promises earlier updates made that are still to be answered. */
export function UpdateDialogWithPromises({
  project,
  isPublishing,
  failed,
  onClose,
  onPublish,
}: {
  project: Launch["record"];
  isPublishing: boolean;
  failed: boolean;
  onClose: () => void;
  onPublish: (draft: UpdateDraft) => Promise<void>;
}) {
  const { record, failed: readFailed, retry } = useProjectRecord(project);
  // Not read yet: nothing to ask about so far. Not readable: the dialog says so.
  const due = useMemo(
    () => (record ? duePromises(record.promises) : readFailed ? null : []),
    [record, readFailed],
  );
  return (
    <PostUpdateDialog
      due={due}
      failed={failed}
      isPublishing={isPublishing}
      onClose={onClose}
      onPublish={onPublish}
      onRetryDue={retry}
    />
  );
}
