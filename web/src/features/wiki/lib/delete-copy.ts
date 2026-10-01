/**
 * Delete / restore dialog copy — the one label owner for the wiki's deletion
 * surface, so the toolbar buttons, dialogs and toasts never drift apart.
 *
 * The deletion model has two intents and the copy keeps them apart:
 *
 * - **Delete** (any authorized editor) is restorable: the page moves to
 *   "Recently deleted" and anyone on the team can restore it.
 * - **Delete permanently** (community admins only) removes the content from
 *   the server; it cannot be restored. That dialog is typed confirmation.
 *
 * Alias-free so `delete-copy.test.mjs` can drive it under `node --test`.
 */

/** Toolbar/row label for the restorable delete. */
export const DELETE_LABEL = "Delete";
/** Toolbar/row label for the permanent, admin-only delete. */
export const PURGE_LABEL = "Delete permanently";
/** The section name both surfaces use for the tombstoned-page list. */
export const RECENTLY_DELETED_LABEL = "Recently deleted";
/** Row action that republishes a tombstoned page as a new revision. */
export const RESTORE_LABEL = "Restore";

export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/** The restorable-delete confirmation (the default delete for everyone). */
export function deleteDialogCopy(slug: string): ConfirmCopy {
  return {
    title: `Delete “${slug}”?`,
    description:
      "Moves the page to Recently deleted. Anyone on the team can restore it.",
    confirmLabel: "Delete page",
  };
}

/** The permanent-delete confirmation (admins; typed confirmation). */
export function purgeDialogCopy(slug: string): ConfirmCopy {
  return {
    title: `Delete “${slug}” permanently?`,
    description: `The content is removed from the server and cannot be restored. This cannot be undone.`,
    confirmLabel: PURGE_LABEL,
  };
}

/** Prompt for the typed confirmation the purge dialog requires. */
export const PURGE_TYPE_PROMPT = "Type the page name to confirm";

/** Whether the typed confirmation matches the page being purged. */
export function purgeConfirmed(typed: string, slug: string): boolean {
  return typed.trim() === slug;
}

/** The restore confirmation (a plain dialog — restoring is not destructive). */
export function restoreDialogCopy(slug: string): ConfirmCopy {
  return {
    title: "Restore this page?",
    description: `“${slug}” returns to the wiki as a new revision.`,
    confirmLabel: RESTORE_LABEL,
  };
}

/** Empty state for the Recently-deleted list. */
export const RECENTLY_DELETED_EMPTY = "Nothing has been deleted.";

/** Error state title for the Recently-deleted list. */
export const RECENTLY_DELETED_ERROR_TITLE = "Couldn't load deleted pages";
