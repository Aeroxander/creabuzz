import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

interface OverlayPaneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line under the title, read with it by a screen reader. */
  description?: string;
  children: ReactNode;
  testId?: string;
}

function CloseButton() {
  return (
    <RadixDialog.Close
      aria-label="Close"
      className="btn btn-ghost btn-sm -mr-2 text-ink"
    >
      <X aria-hidden="true" size={20} />
    </RadixDialog.Close>
  );
}

function Header({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <RadixDialog.Title className="headline text-xl">
          {title}
        </RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="mt-1 text-sm text-muted">
            {description}
          </RadixDialog.Description>
        ) : (
          <RadixDialog.Description className="sr-only">
            {title}
          </RadixDialog.Description>
        )}
      </div>
      <CloseButton />
    </div>
  );
}

/** A pane that rises from the bottom of a phone screen: the place for a short task that keeps the screen behind it. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  testId,
}: OverlayPaneProps) {
  return (
    <RadixDialog.Root onOpenChange={onOpenChange} open={open}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay z-40" />
        <RadixDialog.Content
          className={cn(
            "sheet fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[90dvh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-3xl px-4 pt-3",
          )}
          data-testid={testId}
          style={{ paddingBottom: "calc(var(--safe-bottom) + 20px)" }}
        >
          <div
            aria-hidden="true"
            className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-white/30"
          />
          <Header description={description} title={title} />
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A pane in the middle of the screen, for a question that must be answered before going on. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  testId,
}: OverlayPaneProps) {
  return (
    <RadixDialog.Root onOpenChange={onOpenChange} open={open}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay z-40" />
        <RadixDialog.Content
          className="sheet fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-3xl p-5"
          data-testid={testId}
        >
          <Header description={description} title={title} />
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
