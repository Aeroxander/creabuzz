import { BookMarked } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Badge } from "@/shared/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { relativeTime } from "@/shared/lib/relative-time";
import type { Repo } from "../use-repos";

export function RepoListItem({
  repo,
  ownerName,
  preview = false,
}: {
  repo: Repo;
  /** The owner's username, resolved once for the whole list by the caller. */
  ownerName: string;
  preview?: boolean;
}) {
  return (
    <div className="py-6 text-black dark:text-white">
      {/* Row 1: Name + badge */}
      <div className="flex items-center gap-2">
        <BookMarked className="h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
        <Link
          to="/repos/$repoId"
          params={{ repoId: repo.id }}
          search={preview ? { preview: "repositories" } : undefined}
          className="text-lg font-semibold text-black underline-offset-4 hover:text-black/70 hover:underline dark:text-white dark:hover:text-white/70"
        >
          {repo.name}
        </Link>
        <Badge
          variant="outline"
          className="ml-1 border-black/15 text-black/60 dark:border-white/15 dark:text-white/60"
        >
          Public
        </Badge>
      </div>

      {/* Row 2: Description */}
      {repo.description && (
        <p className="mt-1 line-clamp-2 text-sm text-black/60 dark:text-white/60">
          {repo.description}
        </p>
      )}

      {/* Row 3: Metadata */}
      <div className="mt-2 flex items-center gap-4 text-xs text-black/60 dark:text-white/60">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">{ownerName}</span>
          </TooltipTrigger>
          <TooltipContent>
            {/* The name says who owns this; the full hex stays next to it. */}
            <div className="flex flex-col">
              <span className="text-xs font-medium">{ownerName}</span>
              <span className="font-mono text-xs">{repo.owner}</span>
            </div>
          </TooltipContent>
        </Tooltip>
        <span>Updated {relativeTime(repo.createdAt)}</span>
      </div>
    </div>
  );
}
