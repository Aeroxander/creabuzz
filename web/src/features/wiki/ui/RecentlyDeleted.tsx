import { Undo2 } from "lucide-react";

import { QueryError, errorMessage } from "@/shared/ui/query-error";

import {
  PURGE_LABEL,
  RECENTLY_DELETED_EMPTY,
  RECENTLY_DELETED_ERROR_TITLE,
  RECENTLY_DELETED_LABEL,
  RESTORE_LABEL,
} from "../lib/delete-copy";
import type { TombstonedPage } from "../lib/page-index";

/**
 * "Recently deleted": pages hidden by a RESTORABLE tombstone, newest deletion
 * first. Every row offers Restore (republish as a new revision); community
 * admins additionally get the deliberate, typed "Delete permanently". Empty
 * and error states are explicit, and the error state retries (repo rule 6 —
 * no dead ends).
 */
export function RecentlyDeleted({
  entries,
  isLoading,
  error,
  onRetry,
  isAdmin,
  busySlug,
  onRestore,
  onPurge,
}: {
  entries: TombstonedPage[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  isAdmin: boolean;
  /** Slug with an action in flight, for row-level busy state. */
  busySlug: string | null;
  onRestore: (entry: TombstonedPage) => void;
  onPurge: (entry: TombstonedPage) => void;
}) {
  return (
    <div
      className="mx-auto w-full max-w-3xl space-y-3 p-4"
      data-testid="wiki-recently-deleted"
    >
      <h2 className="text-sm font-semibold">{RECENTLY_DELETED_LABEL}</h2>
      {error ? (
        <QueryError
          description="The relay did not answer the deleted-pages query, so the list is unknown."
          message={errorMessage(error)}
          onRetry={onRetry}
          testId="wiki-recently-deleted-error"
          title={RECENTLY_DELETED_ERROR_TITLE}
        />
      ) : isLoading ? (
        <div className="space-y-2">
          {["a", "b"].map((k) => (
            <div
              className="h-10 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
              key={k}
            />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p
          className="text-2xs text-black/60 dark:text-white/60"
          data-testid="wiki-recently-deleted-empty"
        >
          {RECENTLY_DELETED_EMPTY}
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li
              className="flex flex-wrap items-center gap-2 rounded-md border border-black/10 px-3 py-2 dark:border-white/10"
              data-testid="wiki-recently-deleted-row"
              key={entry.slug}
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {entry.slug}
              </span>
              <button
                className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 dark:border-white/15"
                data-testid="wiki-restore"
                disabled={busySlug === entry.slug}
                onClick={() => onRestore(entry)}
                type="button"
              >
                <Undo2 className="h-3 w-3" /> {RESTORE_LABEL}
              </button>
              {isAdmin ? (
                <button
                  className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 text-red-700 dark:border-white/15 dark:text-red-400"
                  data-testid="wiki-purge"
                  disabled={busySlug === entry.slug}
                  onClick={() => onPurge(entry)}
                  type="button"
                >
                  {PURGE_LABEL}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
