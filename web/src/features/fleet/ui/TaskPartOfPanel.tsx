import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { failureWords } from "@/shared/lib/readable-error";

import { partOfFromKey, partOfKey, type TaskPartOf } from "../lib/task-part-of";
import type { PartOfOptions } from "../use-part-of";
import type { WorkItem } from "../use-work-board";

/** "Docs: First hour notes": the project's name from the community's own list, the area's as its Work tab shows it. */
function partOfLabel(link: TaskPartOf, options: PartOfOptions): string {
  const project = options.launchAt(link.project)?.record.name ?? "A project";
  return `${project}: ${options.areaTitle(link)}`;
}

/**
 * The "Part of" choice: not part of a project, or one open work area of a contributor project in this community. A
 * link already saved stays choosable when its area is no longer open, so editing something else never drops it.
 */
export function PartOfPicker({
  value,
  onChange,
  options,
  saved,
  label,
  className,
  testId,
}: {
  /** A picker value (`partOfKey`), or "" for none. */
  value: string;
  onChange: (value: string) => void;
  options: PartOfOptions;
  saved: TaskPartOf | null;
  /** Its accessible name: the new-task form's and an open task's pickers can be on screen together. */
  label: string;
  className?: string;
  testId: string;
}) {
  const savedKey = saved ? partOfKey(saved) : "";
  const listed = options.choices.some((choice) =>
    choice.areas.some((area) => partOfKey(area.link) === savedKey),
  );
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={className}
      data-testid={testId}
    >
      <option value="">Not part of a project</option>
      {saved && !listed ? (
        <option value={savedKey}>
          {partOfLabel(saved, options)} (not open now)
        </option>
      ) : null}
      {options.choices.map((choice) => (
        <optgroup key={choice.coordinate} label={choice.name}>
          {choice.areas.map((area) => (
            <option key={partOfKey(area.link)} value={partOfKey(area.link)}>
              {area.title}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Which contributor project's work area a task is part of, with the way to that project's Work tab, where the work
 * is taken on and submitted. Finishing the task here awards nothing, and the panel says so. Mount it with
 * `key={item.key}` so the choice resets per task.
 */
export function TaskPartOfPanel({
  item,
  options,
  onSave,
}: {
  item: WorkItem;
  options: PartOfOptions;
  onSave: (partOf: TaskPartOf | null) => Promise<void>;
}) {
  const saved = item.partOf ?? null;
  const [value, setValue] = useState(saved ? partOfKey(saved) : "");
  const [saving, setSaving] = useState(false);
  const launch = saved ? options.launchAt(saved.project) : null;
  // Nothing to link to and nothing linked: the panel would only be an empty picker.
  if (!saved && options.choices.length === 0) return null;
  const dirty = value !== (saved ? partOfKey(saved) : "");

  return (
    <section
      aria-label="Part of a project"
      className="mt-3 flex flex-col gap-2 border-t border-black/10 pt-3 dark:border-white/10"
      data-testid="task-part-of"
    >
      {saved ? (
        <p className="text-sm" data-testid="task-part-of-current">
          Part of {partOfLabel(saved, options)}
          {launch ? (
            <>
              {" · "}
              <Link
                className="underline"
                to="/launchpad/$launchId"
                params={{ launchId: launch.record.id }}
                search={{ author: launch.record.author, tab: "work" }}
                data-testid="task-part-of-link"
              >
                Open the Work tab
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {saved && !launch ? (
        <p className="text-2xs text-black/60 dark:text-white/60">
          This project is not listed in this community, so there is no Work tab
          to open.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <PartOfPicker
          value={value}
          onChange={setValue}
          options={options}
          saved={saved}
          label="This task is part of"
          className="min-w-0 max-w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
          testId="task-part-of-select"
        />
        {dirty ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              onSave(partOfFromKey(value))
                .catch((error: unknown) =>
                  toast.error("Couldn't save what this task is part of", {
                    description: failureWords(error).text,
                  }),
                )
                .finally(() => setSaving(false));
            }}
            className="rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            data-testid="task-part-of-save"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      <p className="text-2xs text-black/60 dark:text-white/60">
        Finishing this task here awards nothing. To earn Shares, take the work
        area on and submit your work on the project's Work tab.
      </p>
    </section>
  );
}
