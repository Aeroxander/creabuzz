/**
 * Small parts of the project page that read the project's own records, kept out of the page so it can use them
 * after it knows which project it shows.
 */

import { useEffect, useMemo } from "react";

import { ProjectProgressFeed } from "@/features/feed/ui/ProjectProgressFeed";

import type { LaunchTab, TabUse } from "../lib/launch-tabs";
import { duePromises } from "../lib/promises";
import { teamOf } from "../lib/help-request";
import { acceptedSince, type UpdateDraft } from "../lib/weekly-update";
import { useProjectTasks } from "../use-tasks";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { useProjectRecord } from "../use-project-record";
import { useTabUses } from "../use-tab-uses";
import { PostUpdateDialog } from "./PostUpdateDialog";

/** Tells the page which of its shown-when-used tabs this project uses, and how many updates it has. Shows nothing. */
export function TabUsesProbe({
  launch,
  onUses,
}: {
  launch: Launch;
  onUses: (state: {
    uses: Partial<Record<LaunchTab, TabUse>>;
    updates: number | null;
    updatesComplete: boolean;
  }) => void;
}) {
  const {
    uses: { updates: updatesUse, boards, agents },
    updates,
    updatesComplete,
  } = useTabUses(launch);
  useEffect(() => {
    onUses({
      uses: { updates: updatesUse, boards, agents },
      updates,
      updatesComplete,
    });
  }, [updatesUse, boards, agents, updates, updatesComplete, onUses]);
  return null;
}

/**
 * The Updates tab: every update of this project, from the same read of its own records the card at the top uses (its
 * update records and the posts marked as its updates), not from the list of every project, which is cut at a fixed
 * size. Until that read answers, and if it fails, the list shows what the page already has.
 */
export function ProjectUpdatesTab({ launch }: { launch: Launch }) {
  const data = useProjectUpdates(launch.record).data;
  const project = useMemo(
    () => (data ? { ...launch, updates: data.updates } : launch),
    [launch, data],
  );
  return <ProjectProgressFeed posts={data?.posts} project={project} />;
}

/** The update dialog, with the promises earlier updates made that are still to be answered. */
export function UpdateDialogWithPromises({
  project,
  isPublishing,
  failed,
  failedWhy,
  onClose,
  onPublish,
}: {
  project: Launch["record"];
  isPublishing: boolean;
  failed: boolean;
  failedWhy?: string | null;
  onClose: () => void;
  onPublish: (draft: UpdateDraft) => Promise<void>;
}) {
  const { record, failed: readFailed, retry } = useProjectRecord(project);
  // Not read yet: nothing to ask about so far. Not readable: the dialog says so.
  const due = useMemo(
    () => (record ? duePromises(record.promises) : readFailed ? null : []),
    [record, readFailed],
  );
  // Work accepted since the team's last weekly update: offered as lines, once both reads have answered in full.
  const updates = useProjectUpdates(project);
  const work = useProjectTasks(project);
  const accepted = useMemo(() => {
    if (!updates.data?.complete || !work.tasks || !work.complete) return [];
    const now = Math.floor(Date.now() / 1000);
    const team = teamOf(project);
    const times = updates.data.updates
      .filter((u) => team.has(u.author) && u.weekly && u.createdAt <= now)
      .map((u) => u.createdAt);
    return acceptedSince(
      work.tasks,
      times.length > 0 ? Math.max(...times) : null,
      now,
    ).map((task) => ({ id: task.id, what: task.what }));
  }, [updates.data, work.tasks, work.complete, project]);
  return (
    <PostUpdateDialog
      accepted={accepted}
      due={due}
      failed={failed}
      failedWhy={failedWhy}
      isPublishing={isPublishing}
      onClose={onClose}
      onPublish={onPublish}
      onRetryDue={retry}
    />
  );
}
