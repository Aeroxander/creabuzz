/**
 * One weekly update laid out under three plain headings (`lib/update-view.ts`): "Last week's promises" as one row each
 * (Kept, Missed, Changed or Not answered, the promise, the reason in muted text), "This week" and "Next week's
 * promises". Each state is words and an icon, never colour alone, and a miss is never red. An update that cannot be laid
 * out is shown as it was written.
 */

import { Check, CircleDashed, type LucideIcon, Replace, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import {
  LAST_WEEK_LABEL,
  type LastWeekState,
  type UpdateView,
} from "../lib/update-view";

const TONE: Record<LastWeekState, ChipTone> = {
  kept: "success",
  // A miss is a fact, not an alarm: amber, with its word and icon.
  missed: "warning",
  changed: "neutral",
  unanswered: "neutral",
};

const ICON: Record<LastWeekState, LucideIcon> = {
  kept: Check,
  missed: X,
  changed: Replace,
  unanswered: CircleDashed,
};

/** Words clipped at `max` characters, with "Read more" to open the rest and "Show less" to close it again. */
function Clipped({ text, max }: { text: string; max: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > max;
  return (
    <>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
        {long && !open ? `${text.slice(0, max)}…` : text}
      </p>
      {long ? (
        <Button
          aria-expanded={open}
          className="h-auto p-0 max-sm:h-11"
          data-testid="update-read-more"
          onClick={() => setOpen((was) => !was)}
          size="sm"
          type="button"
          variant="link"
        >
          {open ? "Show less" : "Read more"}
        </Button>
      ) : null}
    </>
  );
}

export function UpdateSections({
  view,
  max,
}: {
  view: UpdateView;
  /** The most characters of the words to show before "Read more". */
  max: number;
}) {
  if (!view.structured)
    return view.plain ? (
      <div data-testid="update-plain">
        <Clipped max={max} text={view.plain} />
      </div>
    ) : null;
  return (
    <>
      {view.lastWeek.length > 0 ? (
        <div className="mt-2" data-testid="update-last-week">
          <h4 className="text-xs font-semibold text-muted-foreground">
            Last week's promises
          </h4>
          <ul className="mt-1 flex flex-col gap-1.5">
            {view.lastWeek.map((row, i) => (
              <li
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                data-state={row.state}
                data-testid="update-promise-row"
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are in the order the update names them
                key={i}
              >
                <Chip icon={ICON[row.state]} tone={TONE[row.state]}>
                  {LAST_WEEK_LABEL[row.state]}
                </Chip>
                <span className="min-w-0 break-words text-sm">{row.text}</span>
                {row.note ? (
                  <span className="w-full break-words text-xs text-muted-foreground">
                    {row.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.thisWeek ? (
        <div className="mt-2" data-testid="update-this-week">
          <h4 className="text-xs font-semibold text-muted-foreground">
            This week
          </h4>
          <Clipped max={max} text={view.thisWeek} />
        </div>
      ) : null}
      {view.nextWeek.length > 0 ? (
        <div className="mt-2" data-testid="update-next-week">
          <h4 className="text-xs font-semibold text-muted-foreground">
            {view.nextAreSigned ? "Next week's promises" : "What's next"}
          </h4>
          <ul className="mt-0.5 list-disc pl-5 text-sm">
            {view.nextWeek.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are in the order the update names them
              <li className="break-words" key={i}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
