import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Render a child at the document root.
 *
 * Overlays must escape the stacking context of whatever triggered them. The
 * header uses `backdrop-blur`, which makes it both a containing block and a
 * stacking context — so a `fixed inset-0 z-50` dialog rendered inside it is
 * boxed into the nav's own rect and painted at the nav's level, where later
 * page content covers it. Portalling puts the overlay in the root stacking
 * context, where its z-index means what it says. (`alert-dialog.tsx` already
 * gets this right through Radix's Portal; these are the hand-rolled overlays.)
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

/** A full-screen overlay, portalled to the root. */
export function Overlay({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Portal>
      <div className={className} {...rest}>
        {children}
      </div>
    </Portal>
  );
}

/**
 * Place a popover next to an anchor, at the root.
 *
 * Measured from the anchor's own box, so it lands where the reader expects
 * even though it is no longer inside the anchor's stacking context. Recomputed
 * while open, since scrolling and resizing move the anchor.
 */
export function useAnchoredStyle(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  place: "below-right" | "below-left" | "above-right" | "above-left" | "right",
): React.CSSProperties {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 288; // the popover is w-72
      const gap = 8;
      switch (place) {
        case "below-right":
          setBox({ top: r.bottom + gap, left: r.right - width });
          break;
        case "below-left":
          setBox({ top: r.bottom + gap, left: r.left });
          break;
        case "above-right":
          setBox({ top: r.top - gap, left: r.right - width });
          break;
        case "above-left":
          setBox({ top: r.top - gap, left: r.left });
          break;
        case "right":
          setBox({ top: r.top, left: r.right + gap });
          break;
      }
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, open, place]);

  if (!box) return { visibility: "hidden" };
  return { position: "fixed", top: box.top, left: box.left };
}
