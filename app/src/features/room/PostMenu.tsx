/**
 * The "More" press on a post of the room and what it offers: for everyone Report and Hide, and for the project's team Remove
 * this post and Stop the person writing (or let them write again). It is a sheet of plain presses, so a phone has no tiny
 * menu to hit; each press is named with the author so a screen reader hears whose post it is.
 */
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";

export type MenuChoice =
  | "report"
  | "hide"
  | "remove"
  | "stop"
  | "allow"
  | "repost"
  | "unrepost"
  | "quote"
  | "edit"
  | "delete"
  | "hide-pictures";

/** An item a screen adds to the menu: its press, its words, and (when it cannot be pressed now) the reason in words. */
export interface ExtraItem {
  choice: MenuChoice;
  label: string;
  /** Why it cannot be used now: the item is shown but not pressable, with this under it. */
  unavailable?: string;
}

export function PostMenu({
  name,
  mine,
  teamCanRemove,
  teamCanStop,
  stopped,
  onChoose,
  extra = [],
  sheetTitle,
}: {
  name: string;
  /** Items put before the rest (repost, quote, edit, delete). */
  extra?: readonly ExtraItem[];
  /** The sheet's title when it is not `<name>'s post` (the viewer's own post). */
  sheetTitle?: string;
  /** The post is the viewer's own: nothing to report or hide. */
  mine: boolean;
  teamCanRemove: boolean;
  teamCanStop: boolean;
  /** The person is stopped from writing now (so the press lifts it). */
  stopped: boolean;
  onChoose: (choice: MenuChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (choice: MenuChoice) => {
    setOpen(false);
    onChoose(choice);
  };
  const items: ExtraItem[] = [
    ...extra,
    ...(mine
      ? []
      : [
          { choice: "report" as const, label: "Report" },
          { choice: "hide" as const, label: `Hide ${name}'s posts` },
        ]),
    ...(teamCanRemove
      ? [{ choice: "remove" as const, label: "Remove this post" }]
      : []),
    ...(teamCanStop
      ? [
          stopped
            ? { choice: "allow" as const, label: `Let ${name} write again` }
            : { choice: "stop" as const, label: `Stop ${name} writing here` },
        ]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <>
      <button
        aria-haspopup="dialog"
        className="btn btn-ghost btn-sm text-muted"
        data-testid="post-more"
        onClick={() => setOpen(true)}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={18} />
        <span className="sr-only">{`More actions for ${name}'s post`}</span>
      </button>
      <Sheet
        onOpenChange={setOpen}
        open={open}
        testId="post-menu"
        title={sheetTitle ?? `${name}'s post`}
      >
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div className="flex flex-col gap-1" key={item.choice}>
              <Button
                aria-describedby={
                  item.unavailable ? `menu-why-${item.choice}` : undefined
                }
                block
                data-testid={`menu-${item.choice}`}
                disabled={Boolean(item.unavailable)}
                onClick={() => choose(item.choice)}
                variant="secondary"
              >
                {item.label}
              </Button>
              {item.unavailable ? (
                <p
                  className="px-1 text-xs text-muted"
                  id={`menu-why-${item.choice}`}
                >
                  {item.unavailable}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
