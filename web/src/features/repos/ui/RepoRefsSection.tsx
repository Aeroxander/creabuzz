import { GitBranch, Hash, Tag } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import type { RepoRefs } from "../use-repo-refs";

export function RepoRefsSection({
  refs,
  isLoading,
  error = null,
  onRetry,
}: {
  refs: RepoRefs | undefined;
  isLoading: boolean;
  /** Why the branches and tags could not be read; shown instead of them, never as "No commits yet". */
  error?: Error | null;
  onRetry?: () => void;
}) {
  if (isLoading) return null;

  if (error) {
    return (
      <div
        role="alert"
        data-testid="repo-refs-error"
        className="mt-6 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <p className="font-semibold">Couldn't show branches and tags</p>
        <p className="mt-1 opacity-90">{error.message}</p>
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={onRetry}
          >
            Try again
          </Button>
        )}
      </div>
    );
  }

  const hasRefs = refs && (refs.branches.length > 0 || refs.tags.length > 0);

  return (
    <div className="mt-6">
      {hasRefs ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-black/60 dark:text-white/60">
          {refs.head && (
            <>
              <div className="flex items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className="bg-black/5 text-black dark:bg-white/10 dark:text-white"
                >
                  <GitBranch className="mr-1 h-4 w-4" />
                  {refs.head.ref}
                </Badge>
                {refs.head.sha && (
                  <Badge
                    variant="outline"
                    className="border-black/15 font-mono text-xs text-black/60 dark:border-white/15 dark:text-white/60"
                  >
                    <Hash className="mr-0.5 h-4 w-4" />
                    {refs.head.sha.slice(0, 7)}
                  </Badge>
                )}
              </div>
              <span className="text-black/60 dark:text-white/60">&middot;</span>
            </>
          )}
          <span className="flex items-center gap-1">
            <GitBranch className="h-4 w-4" />
            {refs.branches.length}{" "}
            {refs.branches.length === 1 ? "branch" : "branches"}
          </span>
          <span className="text-black/60 dark:text-white/60">&middot;</span>
          <span className="flex items-center gap-1">
            <Tag className="h-4 w-4" />
            {refs.tags.length} {refs.tags.length === 1 ? "tag" : "tags"}
          </span>
        </div>
      ) : (
        <p className="text-sm text-black/60 dark:text-white/60">
          No commits yet
        </p>
      )}
    </div>
  );
}
