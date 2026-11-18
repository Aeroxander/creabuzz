/**
 * Where a new board belongs: one of the projects the person started, or no project (a board for the whole server).
 * Shown only to someone who started a project, since only they can add a board to one.
 */

import type { Launch } from "@/features/launchpad/models";

export function ProjectChoice({
  id,
  projects,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  projects: readonly Launch[];
  /** The chosen project's id, or "" for none. */
  value: string;
  onChange: (projectId: string) => void;
  disabled?: boolean;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="board-project-choice">
      <label className="text-sm font-medium" htmlFor={id}>
        Project (optional)
      </label>
      <select
        className="h-9 w-full rounded-md border border-black/15 bg-white px-2 text-sm dark:border-white/15 dark:bg-white/5"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">No project: a board for the whole server</option>
        {projects.map((launch) => (
          <option key={launch.record.id} value={launch.record.id}>
            {launch.record.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        A project's boards are on its page and under its name in Boards.
      </p>
    </div>
  );
}
