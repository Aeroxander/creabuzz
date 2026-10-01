import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Input } from "@/shared/ui/input";

import type { TombstonedWikiPage } from "../lib/pageIndex";
import {
  deleteWikiPage,
  restoreTombstonedPage,
  tombstonesQueryKey,
  useTombstonedPages,
} from "../useWikiPages";

// One label owner for the delete/restore copy on desktop (mirrors the web
// client's `lib/delete-copy.ts`): the restorable delete says where the page
// goes, the admin purge says the content is removed from the server and
// cannot be restored, and restore is a plain (non-destructive) confirm.
const RESTORE_TITLE = "Restore this page?";
const restoreDescription = (slug: string) =>
  `“${slug}” returns to the wiki as a new revision.`;
const PURGE_TITLE_SUFFIX = "permanently?";
const purgeTitle = (slug: string) => `Delete “${slug}” ${PURGE_TITLE_SUFFIX}`;
const PURGE_DESCRIPTION =
  "The content is removed from the server and cannot be restored. This cannot be undone.";
const PURGE_LABEL = "Delete permanently";
const PURGE_TYPE_PROMPT = "Type the page name to confirm";
const RECENTLY_DELETED_TITLE = "Recently deleted";
const RECENTLY_DELETED_EMPTY = "Nothing has been deleted.";

/**
 * "Recently deleted": pages hidden by a RESTORABLE tombstone. Every row offers
 * Restore (republish as a new revision — a plain dialog, restoring is not
 * destructive); community admins additionally get the deliberate, typed
 * "Delete permanently" (an alert dialog). Empty and error states are
 * explicit; the error state retries (repo rule 6 — no dead ends).
 */
export function RecentlyDeletedPanel({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const tombstones = useTombstonedPages(true);
  const entries = tombstones.data ?? [];
  const [pendingRestore, setPendingRestore] =
    React.useState<TombstonedWikiPage | null>(null);
  const [pendingPurge, setPendingPurge] =
    React.useState<TombstonedWikiPage | null>(null);
  const [typed, setTyped] = React.useState("");
  const [busySlug, setBusySlug] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: tombstonesQueryKey });
    void queryClient.invalidateQueries({ queryKey: ["wiki", "pages"] });
    void queryClient.invalidateQueries({ queryKey: ["knowledge-pages"] });
  };

  const runRestore = async () => {
    const entry = pendingRestore;
    setPendingRestore(null);
    if (!entry) return;
    setBusySlug(entry.slug);
    setActionError(null);
    try {
      await restoreTombstonedPage(entry);
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySlug(null);
    }
  };

  const runPurge = async () => {
    const entry = pendingPurge;
    setPendingPurge(null);
    setTyped("");
    if (!entry) return;
    setBusySlug(entry.slug);
    setActionError(null);
    try {
      await deleteWikiPage({
        slug: entry.slug,
        authorPubkey: entry.authorPubkey,
        purge: true,
        viewerIsAdmin: true,
      });
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <div
      className="mx-auto w-full max-w-3xl space-y-3 p-4"
      data-testid="wiki-recently-deleted"
    >
      <h2 className="text-sm font-semibold">{RECENTLY_DELETED_TITLE}</h2>
      {actionError ? (
        <p className="text-2xs text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      {tombstones.isError ? (
        <EmptyState
          action={
            <Button
              onClick={() => void tombstones.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          }
          description="The relay did not answer the deleted-pages query, so the list is unknown. Check the connection, then retry."
          testId="wiki-recently-deleted-error"
          title="Couldn't load deleted pages"
          variant="error"
        />
      ) : tombstones.isPending ? (
        <EmptyState
          testId="wiki-recently-deleted-loading"
          title="Loading deleted pages…"
        />
      ) : entries.length === 0 ? (
        <EmptyState
          description={RECENTLY_DELETED_EMPTY}
          testId="wiki-recently-deleted-empty"
          title={RECENTLY_DELETED_TITLE}
        />
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li
              className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
              data-testid="wiki-recently-deleted-row"
              key={entry.slug}
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {entry.slug}
              </span>
              <Button
                data-testid="wiki-restore"
                disabled={busySlug === entry.slug}
                onClick={() => setPendingRestore(entry)}
                size="xs"
                type="button"
                variant="outline"
              >
                <Undo2 aria-hidden="true" className="h-3 w-3" /> Restore
              </Button>
              {isAdmin ? (
                <Button
                  data-testid="wiki-purge"
                  disabled={busySlug === entry.slug}
                  onClick={() => setPendingPurge(entry)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {PURGE_LABEL}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Restore is a PLAIN dialog (role="dialog"): not destructive. */}
      <AlertDialog
        onOpenChange={(next) => {
          if (!next) setPendingRestore(null);
        }}
        open={pendingRestore !== null}
      >
        <AlertDialogContent data-testid="wiki-restore-dialog" role="dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{RESTORE_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRestore ? restoreDescription(pendingRestore.slug) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingRestore(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="wiki-restore-confirm"
              onClick={() => void runRestore()}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Purge is an ALERT dialog with typed confirmation (admins only). */}
      <AlertDialog
        onOpenChange={(next) => {
          if (!next) {
            setPendingPurge(null);
            setTyped("");
          }
        }}
        open={pendingPurge !== null}
      >
        <AlertDialogContent data-testid="wiki-purge-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingPurge ? purgeTitle(pendingPurge.slug) : PURGE_LABEL}
            </AlertDialogTitle>
            <AlertDialogDescription>{PURGE_DESCRIPTION}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <label
              className="text-2xs text-muted-foreground"
              htmlFor="wiki-purge-confirm-input"
            >
              {PURGE_TYPE_PROMPT}
            </label>
            <Input
              data-testid="wiki-purge-confirm-input"
              id="wiki-purge-confirm-input"
              onChange={(e) => setTyped(e.target.value)}
              value={typed}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingPurge(null);
                setTyped("");
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="wiki-purge-confirm"
              disabled={
                !pendingPurge || typed.trim() !== pendingPurge.slug.trim()
              }
              onClick={() => void runPurge()}
            >
              {PURGE_LABEL}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
