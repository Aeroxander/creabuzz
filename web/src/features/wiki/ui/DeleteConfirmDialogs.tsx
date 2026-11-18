import { useEffect, useState } from "react";

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
import { Input } from "@/shared/ui/input";

import {
  PURGE_LABEL,
  PURGE_TYPE_PROMPT,
  purgeConfirmed,
  purgeDialogCopy,
  restoreDialogCopy,
} from "../lib/delete-copy";

/**
 * The permanent-delete confirmation: an ALERT dialog (destructive) with typed
 * confirmation — the deliberate, admin-only secondary action. The confirm
 * button stays disabled until the page name is typed exactly.
 */
export function PurgeConfirmDialog({
  slug,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  slug: string | null;
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const copy = slug ? purgeDialogCopy(slug) : null;
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      open={open}
    >
      <AlertDialogContent data-testid="wiki-purge-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? PURGE_LABEL}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy?.description ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <label
            className="text-2xs text-black/60 dark:text-white/60"
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
          <AlertDialogCancel onClick={onCancel} type="button">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="wiki-purge-confirm"
            disabled={busy || !slug || !purgeConfirmed(typed, slug)}
            onClick={onConfirm}
            type="button"
          >
            {PURGE_LABEL}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The restore confirmation: a PLAIN dialog (role="dialog") — restoring is not
 * destructive, so it must not carry the alert dialog's interruption weight.
 */
export function RestoreConfirmDialog({
  slug,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  slug: string | null;
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = slug ? restoreDialogCopy(slug) : null;
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      open={open}
    >
      <AlertDialogContent data-testid="wiki-restore-dialog" role="dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? "Restore"}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy?.description ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} type="button">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="wiki-restore-confirm"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {copy?.confirmLabel ?? "Restore"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
