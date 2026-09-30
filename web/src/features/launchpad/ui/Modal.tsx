import { useEffect, useRef, type ReactNode } from "react";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";

/** Minimal modal shell: fixed overlay + card. Backdrop click or Escape closes. */
export function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Tab stays inside the card; focus returns to the opener on close.
  useFocusTrap(containerRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Backdrop dismiss is mouse-only by design; keyboard users get Escape
  // (effect above) plus the dialog's own tab order.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dismiss layer only
    <div
      className={`fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center overflow-y-auto bg-black/20 p-4 dark:bg-black/50 ${MODAL_BACKDROP_BLUR_CLASS}`}
      onClick={onClose}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation */}
      <div
        aria-label={label}
        className="w-full min-w-0 max-w-lg rounded-2xl bg-white p-5 shadow-xl dark:bg-[#1e1e1e]"
        onClick={(e) => e.stopPropagation()}
        ref={containerRef}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
