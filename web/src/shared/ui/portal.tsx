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

/** How close a popover may come to the window's edges. */
const gapToEdge = 8;

type Box = { top: number; left: number } | { bottom: number; left: number };

/**
 * Place a popover next to an anchor, at the root.
 *
 * Measured from the anchor's own box, so it lands where the reader expects
 * even though it is no longer inside the anchor's stacking context. Measured
 * again on every frame while open, since scrolling, resizing and content that
 * loads late all move the anchor; and kept on screen when the anchor is not.
 */
export function useAnchoredStyle(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  place: "below-right" | "below-left" | "above-right" | "above-left" | "right",
): React.CSSProperties {
  // An "above" popover is pinned by its bottom edge, so it grows upward from the anchor whatever its height.
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const width = 288; // the popover is w-72
    const gap = 8;
    const at = (r: DOMRect): Box => {
      // Never past the bottom of the window, even while the anchor is scrolled out of view.
      const above = Math.max(gapToEdge, window.innerHeight - r.top + gap);
      switch (place) {
        case "below-right":
          return { top: r.bottom + gap, left: r.right - width };
        case "below-left":
          return { top: r.bottom + gap, left: r.left };
        case "above-right":
          return { bottom: above, left: r.right - width };
        case "above-left":
          return { bottom: above, left: r.left };
        case "right":
          return { top: r.top, left: r.right + gap };
      }
    };
    let frame = 0;
    let last = "";
    const follow = () => {
      const el = anchorRef.current;
      if (el) {
        const next = at(el.getBoundingClientRect());
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          setBox(next);
        }
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [anchorRef, open, place]);

  if (!box) return { visibility: "hidden" };
  return { position: "fixed", ...box, left: Math.max(gapToEdge, box.left) };
}
