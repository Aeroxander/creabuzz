import { toast } from "sonner";

const CARD =
  "flex flex-1 flex-col items-start rounded-lg border border-border/70 bg-card px-3 py-2 text-left transition-colors hover:bg-muted/50";

/**
 * Invitation cards under a room's header, the desktop's treatment: they are the next step for a new room, and as
 * buttons in the header row they read as chrome. The room shows them only to someone signed in, and never in a direct
 * thread, whose people are fixed.
 *
 * What "people" means depends on the room and the reader: a private room's own list (a link lets nobody in); the
 * community's invite links, for whoever runs it; otherwise a link to the room, which lets in only those the community
 * already lets in.
 */
export function RoomInviteCards({
  onShowFleet,
  onShowPeople,
  onShowRoomPeople,
}: {
  /** Open the AI helpers page; only for whoever runs the community. */
  onShowFleet?: () => void;
  /** Open the community's People page, where invite links are made; only for whoever runs the community. */
  onShowPeople?: () => void;
  /** Open a private room's list of who can read it. */
  onShowRoomPeople?: () => void;
}) {
  const copyLink = () => {
    const url = window.location.href;
    if (navigator.clipboard) {
      void navigator.clipboard
        .writeText(url)
        .then(() => toast.success("Link to this room copied"))
        .catch(() => toast.error("Couldn't copy the link"));
    } else {
      toast.error("Couldn't copy the link");
    }
  };
  const people = onShowRoomPeople
    ? {
        title: "Add people",
        detail: "Choose who can read it.",
        open: onShowRoomPeople,
      }
    : onShowPeople
      ? {
          title: "Add people",
          detail: "Make an invite link.",
          open: onShowPeople,
        }
      : {
          title: "Share this room",
          detail: "Copy a link to this room.",
          open: copyLink,
        };
  return (
    <div className="flex gap-2 px-4 pb-1">
      {onShowFleet ? (
        <button
          className={CARD}
          data-testid="channel-add-agent"
          onClick={onShowFleet}
          type="button"
        >
          <span className="text-xs font-semibold text-foreground">
            Add an AI helper
          </span>
          <span className="text-xs text-muted-foreground">
            Give this room a helper.
          </span>
        </button>
      ) : null}
      <button
        className={CARD}
        data-testid="channel-add-people"
        onClick={people.open}
        type="button"
      >
        <span className="text-xs font-semibold text-foreground">
          {people.title}
        </span>
        <span className="text-xs text-muted-foreground">{people.detail}</span>
      </button>
    </div>
  );
}
