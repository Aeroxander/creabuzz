import { Loader2 } from "lucide-react";

/** Shown while a lazily-loaded view chunk downloads. */
export function ViewLoadingFallback({
  label = "Loading…",
}: {
  label?: string;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-black/45 dark:text-white/45"
      data-testid="view-loading"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
