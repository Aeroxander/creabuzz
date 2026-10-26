import { Info } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

/**
 * An explanation one press away: a small "i" button with a label, and the words it opens. Keyboard, pointer and touch
 * all reach it the same way (a button with `aria-expanded`, not a hover tooltip).
 */
export function MoreInfo({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="text-xs">
      <button
        aria-controls={id}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:underline"
        data-testid={testId}
        onClick={() => setOpen((was) => !was)}
        type="button"
      >
        <Info aria-hidden className="h-3.5 w-3.5" />
        {label}
      </button>
      <div className="mt-1 text-muted-foreground" hidden={!open} id={id}>
        {children}
      </div>
    </div>
  );
}
