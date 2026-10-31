/**
 * One "Moderate" button that opens a short menu of what the reader may do here, instead of a row of links next to the
 * author's name. A menu button by the WAI-ARIA pattern: the button says it has a menu and whether it is open; the menu
 * takes focus on its first item; arrow keys, Home and End move between items; Escape closes it and returns focus to the
 * button; Tab or a click outside closes it.
 *
 * The menu opens under the button's left edge, or under its right edge when that would run past the window (a phone,
 * with the button mid-row), and is never wider than the window.
 */

import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface ModerateItem {
  label: string;
  testId: string;
  onSelect: () => void;
  /** Takes something away (remove, ban): drawn in the warning colour. */
  destructive?: boolean;
}

function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [
    ...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
  ];
}

export function ModerateMenu({
  items,
  testId,
  label = "Moderate",
  disabled = false,
}: {
  items: ModerateItem[];
  testId: string;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);

  // Measured before paint, so a flipped menu never shows cut off first.
  useLayoutEffect(() => {
    if (!open) {
      setAlignRight(false);
      return;
    }
    const box = menu.current?.getBoundingClientRect();
    if (box && box.right > window.innerWidth - 8) setAlignRight(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuItems(menu.current)[0]?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  if (items.length === 0) return null;

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = menuItems(menu.current);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(false);
  };

  return (
    <span className="relative inline-flex">
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-0.5 underline disabled:opacity-50"
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={button}
        type="button"
      >
        {label}
        <ChevronDown aria-hidden className="h-3 w-3" />
      </button>
      {open ? (
        <div
          aria-label={label}
          className={`absolute top-full z-30 mt-1 min-w-44 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-card py-1 text-sm shadow-lg ${
            alignRight ? "right-0" : "left-0"
          }`}
          id={menuId}
          onKeyDown={onMenuKey}
          ref={menu}
          role="menu"
        >
          {items.map((item) => (
            <button
              className={`block w-full px-3 py-1.5 text-left hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-hidden ${
                item.destructive ? "text-destructive" : "text-foreground"
              }`}
              data-testid={item.testId}
              key={item.testId}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
