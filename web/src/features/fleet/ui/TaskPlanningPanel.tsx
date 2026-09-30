import { useState } from "react";
import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";
import { errorMessage } from "@/shared/ui/query-error";

import { canClaimTask } from "../lib/task-planning";
import type { TaskPlanning } from "../use-task-planning";
import type { WorkItem } from "../use-work-board";

/** Back / Backed toggle for one task. Hidden for people without an identity. */
export function BackButton({
  item,
  planning,
  busy,
  onBusy,
}: {
  item: WorkItem;
  planning: TaskPlanning;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}) {
  if (!existingUserPubkey() || item.type !== "task") return null;
  const backed = planning.supportOf(item).mine === "+";
  return (
    <button
      type="button"
      aria-pressed={backed}
      disabled={busy}
      onClick={() => {
        onBusy(true);
        (backed ? planning.unback(item) : planning.back(item))
          .catch((error: unknown) =>
            toast.error("Couldn't update your backing", {
              description: errorMessage(error),
            }),
          )
          .finally(() => onBusy(false));
      }}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40 ${
        backed
          ? "bg-black text-white dark:bg-white dark:text-black"
          : "border border-black/15 bg-white text-black/70 hover:bg-black/5 dark:border-white/15 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
      }`}
      data-testid="task-back"
    >
      {backed ? "Backed" : "Back"}
    </button>
  );
}

function parseReward(value: string): number | null {
  const n = Number(value);
  return value.trim() !== "" && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : null;
}

/**
 * Planning for one task in the detail panel: backing, the milestone it counts
 * toward, the points it earns, and — once it is done — claiming it as your
 * contribution. Mount it with `key={item.key}` so edits reset per task.
 */
export function TaskPlanningPanel({
  item,
  planning,
  onUpdate,
}: {
  item: WorkItem;
  planning: TaskPlanning;
  onUpdate: (patch: {
    milestone: string | null;
    reward: number | null;
  }) => Promise<void>;
}) {
  const [milestone, setMilestone] = useState(item.milestone ?? "");
  const [reward, setReward] = useState(
    item.reward === null ? "" : String(item.reward),
  );
  const [saving, setSaving] = useState(false);
  const [backing, setBacking] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const viewer = existingUserPubkey();
  const support = planning.supportOf(item);

  const nextMilestone = milestone.trim() === "" ? null : milestone.trim();
  const nextReward = parseReward(reward);
  const dirty = nextMilestone !== item.milestone || nextReward !== item.reward;
  const claimable =
    item.status === "done" &&
    item.doneRowId !== null &&
    canClaimTask(item, viewer);

  return (
    <section
      aria-label="Planning"
      className="mt-3 flex flex-col gap-2 border-t border-black/10 pt-3 dark:border-white/10"
      data-testid="task-planning"
    >
      <div className="flex items-center gap-2">
        <BackButton
          item={item}
          planning={planning}
          busy={backing}
          onBusy={setBacking}
        />
        <span className="text-xs text-black/60 dark:text-white/60">
          {support.up === 0
            ? "Nobody has backed this yet."
            : `Backed by ${support.up} ${support.up === 1 ? "person" : "people"}.`}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Milestone</span>
          <input
            value={milestone}
            onChange={(e) => setMilestone(e.target.value)}
            placeholder="e.g. Public beta"
            maxLength={120}
            className="rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
            data-testid="task-milestone"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Reward (points)</span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
            placeholder="None"
            className="rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
            data-testid="task-reward"
          />
        </label>
      </div>
      <p className="text-2xs text-black/60 dark:text-white/60">
        Points are credited when the finished task is accepted as a
        contribution, and add to the contributor's share of the project.
      </p>
      {dirty ? (
        <div>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              onUpdate({ milestone: nextMilestone, reward: nextReward })
                .catch((error: unknown) =>
                  toast.error("Couldn't save the plan", {
                    description: errorMessage(error),
                  }),
                )
                .finally(() => setSaving(false));
            }}
            className="rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            data-testid="task-planning-save"
          >
            {saving ? "Saving…" : "Save plan"}
          </button>
        </div>
      ) : null}

      {claimable ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={claiming || claimed}
            onClick={() => {
              setClaiming(true);
              planning
                .claim(item)
                .then(() => {
                  setClaimed(true);
                  toast.success("Sent for review", {
                    description:
                      "A reviewer accepts it before the points count.",
                  });
                })
                .catch((error: unknown) =>
                  toast.error("Couldn't claim this task", {
                    description: errorMessage(error),
                  }),
                )
                .finally(() => setClaiming(false));
            }}
            className="rounded-full border border-black/15 bg-white px-3 py-1.5 text-xs font-medium text-black/80 hover:bg-black/5 disabled:opacity-40 dark:border-white/15 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10"
            data-testid="task-claim"
          >
            {claimed
              ? "Claimed — waiting for review"
              : claiming
                ? "Claiming…"
                : "Claim as contribution"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
