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

/**
 * Destructive confirmation.
 *
 * Wraps the shared alert-dialog primitives so destructive actions get one
 * accessible implementation (focus trap, Escape, labelled description) instead
 * of an inline confirm or a second dialog style.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} type="button">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="confirm-accept"
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
