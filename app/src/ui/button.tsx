import { createLink } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { pressHandlers } from "./press";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "sm";

/** The classes of a button, for a link that looks like one. One primary (green) button per screen. */
export function buttonClass({
  variant = "primary",
  size = "md",
  block = false,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
} = {}): string {
  return cn(
    "btn",
    `btn-${variant}`,
    size === "sm" && "btn-sm",
    block && "btn-block",
  );
}

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

/**
 * The button. Primary is the glossy green main action, secondary a glass pane, ghost a green word. 48px tall, 40px
 * small; it presses in and springs back, and holds still under reduced motion.
 */
export function Button({
  variant,
  size,
  block,
  className,
  type = "button",
  disabled,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      {...pressHandlers(
        {
          onPointerDown,
          onPointerUp,
          onPointerLeave,
          onPointerCancel,
          onKeyDown,
          onKeyUp,
          onBlur,
        },
        disabled,
      )}
      className={cn(buttonClass({ variant, size, block }), className)}
      disabled={disabled}
      type={type}
    />
  );
}

interface ButtonAnchorProps extends ComponentProps<"a"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

/** An anchor that looks and presses like the button: the same spring on a finger, a mouse, Space and Enter. */
function ButtonAnchor({
  variant,
  size,
  block,
  className,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...rest
}: ButtonAnchorProps) {
  return (
    <a
      {...rest}
      {...pressHandlers({
        onPointerDown,
        onPointerUp,
        onPointerLeave,
        onPointerCancel,
        onKeyDown,
        onKeyUp,
        onBlur,
      })}
      className={cn(buttonClass({ variant, size, block }), className)}
    />
  );
}

/**
 * A link to another screen that looks like a button (the green "Start a project"), with the press a button has. Use
 * it instead of a `Link` with `buttonClass()`, which would look like a button but not press like one.
 */
export const ButtonLink = createLink(ButtonAnchor);
