/**
 * Deleting, permanently deleting and restoring wiki pages: the three
 * confirmations, what each one does when accepted, and the state that ties
 * them to the page toolbar and the "Recently deleted" list.
 *
 * Whether a page exists on the server is decided from a fresh read, not from
 * this tab's list: a page created and saved moments ago is not in the cached
 * list yet, and treating it as local-only left a published page live for
 * everyone else.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { failureWords } from "@/shared/lib/readable-error";
import { deleteDialogCopy } from "./lib/delete-copy";
import { deleteFailureText } from "./lib/rename-failure";
import type { TombstonedPage } from "./lib/page-index";
import type { WikiPage } from "./use-wiki-pages";
import {
  PurgeConfirmDialog,
  RestoreConfirmDialog,
} from "./ui/DeleteConfirmDialogs";

export interface WikiRemovalDeps {
  activeSlug: string | null;
  setActiveSlug: (slug: string | null) => void;
  readFreshPages: () => Promise<WikiPage[]>;
  deletePage: (
    page: WikiPage,
    options?: { purge?: boolean; viewerIsAdmin?: boolean },
  ) => Promise<void>;
  restoreTombstonedPage: (entry: TombstonedPage) => Promise<void>;
  viewerIsAdmin: boolean;
}

export function useWikiRemoval({
  activeSlug,
  setActiveSlug,
  readFreshPages,
  deletePage,
  restoreTombstonedPage,
  viewerIsAdmin,
}: WikiRemovalDeps): {
  requestDelete: (page: WikiPage) => void;
  requestPurge: (target: { slug: string; authorPubkey?: string }) => void;
  requestRestore: (entry: TombstonedPage) => void;
  /** The page whose purge or restore is in flight, for the list's spinner. */
  busySlug: string | null;
  /** The three confirmation dialogs; render once. */
  dialogs: ReactNode;
} {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<WikiPage | null>(null);
  /** Permanent delete (admins, typed confirm) — a page or a tombstoned row. */
  const [pendingPurge, setPendingPurge] = useState<{
    slug: string;
    authorPubkey?: string;
  } | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  /** Tombstoned page awaiting the plain restore confirmation. */
  const [pendingRestore, setPendingRestore] = useState<TombstonedPage | null>(
    null,
  );
  const [restoreBusy, setRestoreBusy] = useState(false);

  const busySlug = restoreBusy
    ? (pendingRestore?.slug ?? null)
    : purgeBusy
      ? (pendingPurge?.slug ?? null)
      : null;

  const dialogs = (
    <>
      <ConfirmDialog
        confirmLabel={
          pendingDelete ? deleteDialogCopy(pendingDelete.slug).confirmLabel : ""
        }
        description={
          pendingDelete ? deleteDialogCopy(pendingDelete.slug).description : ""
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const page = pendingDelete;
          setPendingDelete(null);
          if (!page) return;
          if (activeSlug === page.slug) setActiveSlug(null);
          // Whether the page exists on the relay is decided from the relay, not
          // from this tab's list: a page created and saved moments ago is not in
          // the cached list yet, and treating it as local-only left a published
          // page live for everyone else.
          void (async () => {
            try {
              const fresh = await readFreshPages();
              const published = fresh.find((p) => p.slug === page.slug);
              if (!published) {
                toast.success(`Discarded ${page.slug}`);
                return;
              }
              await deletePage(published, {
                purge: false,
                viewerIsAdmin,
              });
              toast.success(`Moved ${page.slug} to Recently deleted`);
              void queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
            } catch (error) {
              // The server's own words, for whoever looks: the toast says it plainly.
              console.warn("[wiki] delete failed", error);
              // "Discarded" and "Deleted" both say the page is gone; a failed
              // read tells us nothing about that, so say nothing was changed.
              toast.error("Couldn't delete page", {
                description: deleteFailureText(error),
              });
            }
          })();
        }}
        open={pendingDelete !== null}
        title={pendingDelete ? deleteDialogCopy(pendingDelete.slug).title : ""}
      />

      <PurgeConfirmDialog
        busy={purgeBusy}
        onCancel={() => setPendingPurge(null)}
        onConfirm={() => {
          const target = pendingPurge;
          setPendingPurge(null);
          if (!target) return;
          setPurgeBusy(true);
          void (async () => {
            try {
              // A tombstoned row is already on the relay; a toolbar target is
              // resolved against a fresh read like the restorable delete.
              let author = target.authorPubkey;
              if (!author) {
                const fresh = await readFreshPages();
                const published = fresh.find((p) => p.slug === target.slug);
                if (!published) {
                  toast.success(`Discarded ${target.slug}`);
                  return;
                }
                author = published.authorPubkey;
              }
              await deletePage(
                {
                  slug: target.slug,
                  content: "",
                  updatedAt: 0,
                  authorPubkey: author,
                },
                { purge: true, viewerIsAdmin: true },
              );
              toast.success(`Deleted ${target.slug} permanently`);
              void queryClient.invalidateQueries({
                queryKey: ["wiki-pages"],
              });
              void queryClient.invalidateQueries({
                queryKey: ["wiki-tombstones"],
              });
            } catch (error) {
              toast.error("Couldn't delete the page permanently", {
                description: failureWords(error).text,
              });
            } finally {
              setPurgeBusy(false);
            }
          })();
        }}
        open={pendingPurge !== null}
        slug={pendingPurge?.slug ?? null}
      />

      <RestoreConfirmDialog
        busy={restoreBusy}
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => {
          const entry = pendingRestore;
          setPendingRestore(null);
          if (!entry) return;
          setRestoreBusy(true);
          void (async () => {
            try {
              await restoreTombstonedPage(entry);
              toast.success(`Restored ${entry.slug}`);
              void queryClient.invalidateQueries({
                queryKey: ["wiki-pages"],
              });
              void queryClient.invalidateQueries({
                queryKey: ["wiki-tombstones"],
              });
              void queryClient.invalidateQueries({
                queryKey: ["knowledge-pages"],
              });
            } catch (error) {
              toast.error("Couldn't restore that page", {
                description: failureWords(error).text,
              });
            } finally {
              setRestoreBusy(false);
            }
          })();
        }}
        open={pendingRestore !== null}
        slug={pendingRestore?.slug ?? null}
      />
    </>
  );

  return {
    requestDelete: setPendingDelete,
    requestPurge: setPendingPurge,
    requestRestore: setPendingRestore,
    busySlug,
    dialogs,
  };
}
