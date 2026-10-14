/**
 * Turning a board post into a task, from the Work board.
 *
 * The task is written first, and it is what counts. The note under the post
 * ("the team turned this into a task") is a courtesy to the person who wrote
 * it; if it cannot be sent the task still stands and the caller is told.
 */

import { commentDraft } from "@/features/board/lib/board-events";
import { publishAsUser } from "@/shared/lib/publish-as-user";

import { publishNewTask } from "./lib/task-publish";
import { escalationNote, taskFromPost } from "./lib/task-source";

export async function escalatePost(input: {
  post: { id: string; author: string; title: string; body: string };
  board: string;
  reward: number | null;
  finderReward: number | null;
  milestone?: string | null;
}): Promise<{ noted: boolean }> {
  const task = taskFromPost({ ...input, milestone: input.milestone ?? null });
  // One task per post and person: sending it twice writes the same task.
  await publishNewTask({
    ...task,
    id: `idea-${task.source.post.slice(0, 16)}`,
  });
  try {
    await publishAsUser(
      commentDraft({
        boardId: input.board,
        root: input.post.id,
        parent: input.post.id,
        body: escalationNote({ finderReward: input.finderReward }),
      }),
      "The server didn't accept the note under the post.",
    );
    return { noted: true };
  } catch {
    return { noted: false };
  }
}
