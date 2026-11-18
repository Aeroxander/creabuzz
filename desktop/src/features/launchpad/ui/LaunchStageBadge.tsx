import { cn } from "@/shared/lib/cn";
import type { LaunchStage } from "@/features/launchpad/launchpadModels";
import { STAGE_LABELS } from "@/features/launchpad/lib/launchpadStatus";

const STAGE_STYLES: Record<LaunchStage, string> = {
  draft: "bg-muted text-muted-foreground",
  review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  live: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  funding: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  graduated: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  failed: "bg-destructive/10 text-destructive",
};

export function LaunchStageBadge({ stage }: { stage: LaunchStage }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide",
        STAGE_STYLES[stage],
      )}
    >
      {STAGE_LABELS[stage]}
    </span>
  );
}
