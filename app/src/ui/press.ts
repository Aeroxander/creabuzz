import type {
  FocusEvent,
  KeyboardEvent,
  PointerEvent,
  SyntheticEvent,
} from "react";

/** The class that holds a button down while it is pressed (the same look as `:active`, see `styles/app.css`). */
export const PRESSED_CLASS = "is-pressed";

/** Whether the person asked for less motion: then the press does not move at all. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Handler<E> = ((event: E) => void) | undefined;

function chain<E extends SyntheticEvent>(
  own: (event: E) => void,
  theirs: Handler<E>,
) {
  return (event: E) => {
    theirs?.(event);
    if (!event.defaultPrevented) own(event);
  };
}

interface PressHandlers<T extends HTMLElement> {
  onPointerDown?: Handler<PointerEvent<T>>;
  onPointerUp?: Handler<PointerEvent<T>>;
  onPointerLeave?: Handler<PointerEvent<T>>;
  onPointerCancel?: Handler<PointerEvent<T>>;
  onKeyDown?: Handler<KeyboardEvent<T>>;
  onKeyUp?: Handler<KeyboardEvent<T>>;
  onBlur?: Handler<FocusEvent<T>>;
}

/**
 * Press feedback for a button or a link styled as one, on every way in: a finger or a mouse (pointer), and Space or
 * Enter from a keyboard. Touch browsers do not all report `:active`, so the class is set by hand; it is never set
 * under reduced motion or while the element is disabled. The class lives on the element, so pressing re-renders
 * nothing.
 */
export function pressHandlers<T extends HTMLElement>(
  theirs: PressHandlers<T> = {},
  disabled = false,
): Required<PressHandlers<T>> {
  const down = (event: SyntheticEvent<T>) => {
    if (disabled || prefersReducedMotion()) return;
    event.currentTarget.classList.add(PRESSED_CLASS);
  };
  const up = (event: SyntheticEvent<T>) => {
    event.currentTarget.classList.remove(PRESSED_CLASS);
  };
  const isPressKey = (event: KeyboardEvent<T>) =>
    event.key === " " || event.key === "Enter";
  return {
    onPointerDown: chain((event: PointerEvent<T>) => {
      // Only the main button of a mouse; any touch or pen contact.
      if (event.pointerType === "mouse" && event.button !== 0) return;
      down(event);
    }, theirs.onPointerDown),
    onPointerUp: chain(up, theirs.onPointerUp),
    onPointerLeave: chain(up, theirs.onPointerLeave),
    onPointerCancel: chain(up, theirs.onPointerCancel),
    onKeyDown: chain((event: KeyboardEvent<T>) => {
      if (isPressKey(event) && !event.repeat) down(event);
    }, theirs.onKeyDown),
    onKeyUp: chain((event: KeyboardEvent<T>) => {
      if (isPressKey(event)) up(event);
    }, theirs.onKeyUp),
    onBlur: chain(up, theirs.onBlur),
  };
}
