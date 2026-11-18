import { type ReactNode, type RefObject, useEffect, useRef } from "react";

import { Overlay } from "@/shared/ui/portal";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";

/**
 * The full-window card the sign-up, sign-in and passkey unlock screens share: a modal dialog named by its heading, with
 * keyboard focus kept inside it (the launchpad `Modal`'s trap, `useFocusTrap`) and handed back on close.
 *
 * Not the launchpad `Modal` itself: these screens are not dismissed by a click on the backdrop (the unlock gate cannot
 * be dismissed at all), and their outer layer keeps its test id at the document root, which the overlay-stacking spec
 * checks. Escape runs `onEscape` when one is given, the same as the screen's own close button.
 *
 * Without `initialFocus`, focus starts on the dialog itself (it is focusable from script only), so Shift+Tab from the
 * first focus wraps inside instead of reaching the page behind. `refocusKey` names state that can remove the focused
 * control (the unlock gate's Unlock button while the passkey is asked): when it changes and focus has left the dialog,
 * focus goes back to the dialog.
 */
export function IdentityDialog({
  labelledBy,
  testId,
  onEscape,
  initialFocus,
  refocusKey,
  cardClassName,
  children,
}: {
  /** Id of the heading that names the dialog. */
  labelledBy: string;
  testId?: string;
  onEscape?: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  refocusKey?: unknown;
  cardClassName: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(cardRef, { initialFocus: initialFocus ?? cardRef });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the named state changes, not on what it reads
  useEffect(() => {
    const card = cardRef.current;
    if (!card || card.contains(document.activeElement)) return;
    // Only reclaim focus that was dropped (the focused control was removed), not focus taken by a dialog on top.
    if (document.activeElement && document.activeElement !== document.body)
      return;
    card.focus();
  }, [refocusKey]);

  useEffect(() => {
    if (!onEscape) return;
    const onKey = (event: KeyboardEvent) => {
      // A dialog opened on top (the sign-out confirm) handles its own Escape.
      if (event.key === "Escape" && !event.defaultPrevented) onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);

  return (
    <Overlay
      className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 dark:bg-black/50"
      data-testid={testId}
    >
      <div
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={`${cardClassName} outline-none`}
        ref={cardRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </div>
    </Overlay>
  );
}
