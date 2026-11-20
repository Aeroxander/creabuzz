/**
 * Whether the room has something newer than the person last saw (a post, or a notice from the team): the "New" dot on the
 * Room tab. One small read of the newest post; the team's notices come from what the page already read.
 */
import type { Project } from "../project/project-record";
import { type ProjectActivity, projectUpdates } from "../project/use-project";
import { hasNews } from "./room-seen";
import { roomOf, useRoomNewest } from "./use-room";

export function useRoomNews(
  project: Project,
  enabled: boolean,
  activity: ProjectActivity | undefined,
): boolean {
  const room = enabled ? roomOf(project) : null;
  const newest = useRoomNewest(room, project.coordinate).data ?? 0;
  if (!room) return false;
  const noticeAt = activity
    ? projectUpdates(project, activity)
        .filter((u) => u.kind !== "post")
        .reduce((at, u) => Math.max(at, u.at), 0)
    : 0;
  return hasNews(project.coordinate, Math.max(newest, noticeAt));
}
