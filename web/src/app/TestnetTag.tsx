/**
 * The "Testnet" tag, for as long as this build cannot reach real money, so nobody has to be told on each screen that it
 * is a test version. It goes away when the build enables mainnet, which brings the unaudited notice on every money
 * screen instead.
 *
 * Its explanation is one press away in both layouts (a button with `aria-expanded`, never a hover title, which touch
 * screens and most screen readers never show): a small popover beside the logo on wide screens, and a one-line strip
 * above the phone tab bar that opens in place.
 */

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { mainnetEnabled } from "@/features/launchpad/chain";
import { Portal, useAnchoredStyle } from "@/shared/ui/portal";

const EXPLANATION =
  "This is a test version. Nothing here uses real money, and Shares earned here are test records that will not move to a real network automatically.";

/** The wide top bar's tag beside the logo; pressing it opens the explanation below it. */
export function TestnetChip() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // Portalled and measured against the tag: the top bar's blur would otherwise trap the popover in its own stacking
  // context, behind the page.
  const style = useAnchoredStyle(triggerRef, open, "below-left");

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPress = (event: MouseEvent) => {
      if (
        !(event.target as HTMLElement).closest(
          "[data-testid='testnet-chip'], [data-testid='testnet-explanation']",
        )
      ) {
        close();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (mainnetEnabled()) return null;
  return (
    <>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="shrink-0 rounded-full border border-border bg-secondary px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        data-testid="testnet-chip"
        onClick={() => setOpen((was) => !was)}
        ref={triggerRef}
        type="button"
      >
        Test version
      </button>
      {open ? (
        <Portal>
          <p
            className="fixed z-50 w-72 rounded-xl border border-border bg-background p-3 text-xs text-muted-foreground shadow-xl"
            data-testid="testnet-explanation"
            id={panelId}
            style={style}
          >
            {EXPLANATION}
          </p>
        </Portal>
      ) : null}
    </>
  );
}

/** The phone layout's one line above the tab bar; pressing it opens the explanation in place. */
export function TestnetStrip() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (mainnetEnabled()) return null;
  const Chevron = open ? ChevronDown : ChevronUp;
  return (
    <div
      className="w-full border-t border-border/60 bg-secondary px-4 py-1 text-2xs text-muted-foreground"
      data-testid="testnet-strip"
    >
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-0.5 text-left"
        onClick={() => setOpen((was) => !was)}
        type="button"
      >
        <span className="font-semibold uppercase tracking-wide">
          Test version
        </span>
        <span>No real money here.</span>
        <Chevron aria-hidden className="ml-auto h-3.5 w-3.5 shrink-0" />
      </button>
      {open ? (
        <p className="pb-1" data-testid="testnet-explanation" id={panelId}>
          {EXPLANATION}
        </p>
      ) : null}
    </div>
  );
}
