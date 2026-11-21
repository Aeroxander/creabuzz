import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";
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

/** Whether focus can be given back to `element`: it is still on the page, not turned off and not hidden. */
function canTakeFocus(element: HTMLElement | null): element is HTMLElement {
  return (
    element !== null &&
    element.isConnected &&
    !(element as HTMLButtonElement).disabled &&
    element.getAttribute("aria-hidden") !== "true" &&
    !element.closest("[hidden], [inert]")
  );
}

/**
 * Where focus goes when what opened the pane is gone (a press that took itself off the page, such as the last of a person's
 * Shares taken out): the page's own heading, so a keyboard or screen-reader user lands at the top of what they were reading and
 * not on nothing.
 */
function focusThePage(): void {
  let place: HTMLElement | null = null;
  for (const selector of ["main h1", "h1", "[role='main']", "main"]) {
    place = document.querySelector<HTMLElement>(selector);
    if (place) break;
  }
  if (!place) return;
  if (!place.hasAttribute("tabindex")) place.setAttribute("tabindex", "-1");
  place.focus({ preventScroll: true });
}

/**
 * Gives focus back to what had it when the pane opened. Radix returns focus to a `Trigger` only; these panes are opened
 * from state (a button that sets `open`), so without this focus is lost to the page when the pane closes. When that
 * element is no longer there to take it, focus goes to the page's heading instead.
 */
function useReturnFocus() {
  const from = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      // The page itself is no place to go back to (a press that took no focus, as on Safari): the heading is.
      from.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const back = from.current;
      from.current = null;
      if (canTakeFocus(back)) back.focus();
      else focusThePage();
    },
  };
}

function CloseButton() {
  return (
    <RadixDialog.Close
      aria-label="Close"
      className="btn btn-ghost btn-sm -mr-2 min-h-11 min-w-11 text-ink"
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
  const focus = useReturnFocus();
  return (
    <RadixDialog.Root onOpenChange={onOpenChange} open={open}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay z-40" />
        <RadixDialog.Content
          {...focus}
          className={cn(
            "sheet fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[90dvh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-3xl px-4 pt-3 [&>*]:shrink-0",
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
  const focus = useReturnFocus();
  return (
    <RadixDialog.Root onOpenChange={onOpenChange} open={open}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay z-40" />
        <RadixDialog.Content
          {...focus}
          className="sheet fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-3xl p-5 [&>*]:shrink-0"
          data-testid={testId}
        >
          <Header description={description} title={title} />
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
