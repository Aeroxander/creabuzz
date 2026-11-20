/**
 * What the team and the manager have said, shown in the room beside the posts (plan section 4.6): the team's own update
 * records and the work a helper handed in. No new way to write: these are rows made from what the app already reads, never
 * signed by the room's writers and never counted as posts. Pure.
 */
import type { ProjectTask } from "../tasks/task-record";
import type { ProjectUpdate } from "../project/use-project";

export interface Notice {
  id: string;
  at: number;
  author: string;
  /** "From the team", or "From the manager" for a team member whose role says so. */
  label: "From the team" | "From the manager";
  /** The update's title, or "Work handed in: {title}". */
  title: string;
  /** The first lines of what was said; empty for a hand-in. */
  body: string;
}

const TITLE_MAX = 80;
const BODY_MAX = 240;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

/** The notices from the team's updates and handed-in work, newest first, at most `limit`. */
export function noticesOf(input: {
  updates: readonly ProjectUpdate[];
  tasks: readonly ProjectTask[];
  /** Each team member's role as the project's record says it. */
  roles: ReadonlyMap<string, string>;
  limit?: number;
}): Notice[] {
  const labelOf = (author: string): Notice["label"] =>
    /\bmanager\b/i.test(input.roles.get(author) ?? "")
      ? "From the manager"
      : "From the team";
  const out: Notice[] = [];
  for (const update of input.updates) {
    // A post by anyone is not a notice: only what the team itself wrote.
    if (update.kind === "post") continue;
    out.push({
      id: update.id,
      at: update.at,
      author: update.author,
      label: labelOf(update.author),
      title: cut(
        update.title || update.body.split("\n")[0] || "An update",
        TITLE_MAX,
      ),
      body: update.title ? cut(update.body, BODY_MAX) : "",
    });
  }
  for (const task of input.tasks) {
    if (!task.handIn) continue;
    out.push({
      id: `handed-${task.id}-${task.handIn.id}`,
      at: task.handIn.at,
      author: task.worker ?? task.author,
      label: labelOf(task.author),
      title: `Work handed in: ${cut(task.what, TITLE_MAX)}`,
      body: "",
    });
  }
  return out
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
    .slice(0, input.limit ?? 20);
}
