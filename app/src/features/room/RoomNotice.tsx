/**
 * Something the team or the manager said, shown among the room's posts: labelled "From the team" or "From the manager", with
 * the update's title and first lines (or the work handed in) and its date. Never a post: it has no like and no reply, and is
 * made from what the app already reads, not written by the room's writers.
 */
import { Link } from "@tanstack/react-router";
import { nameOf, type ProfileMetadata } from "../../lib/profiles";
import { cn } from "../../ui/cn";
import { dayText } from "../money/numbers";
import type { Notice } from "./room-notices";

export function RoomNotice({
  notice,
  profiles,
  pinned = false,
}: {
  notice: Notice;
  profiles: Record<string, ProfileMetadata> | undefined;
  pinned?: boolean;
}) {
  return (
    <article
      className={cn(
        "glass glass-text flex flex-col gap-1 rounded-2xl p-4",
        pinned && "border border-mint/50",
      )}
      data-testid={pinned ? "room-notice-pinned" : "room-notice"}
    >
      <p className="text-xs font-semibold text-mint-ink">
        {pinned ? `${notice.label}, pinned` : notice.label}
      </p>
      <p className="text-base font-semibold">{notice.title}</p>
      {notice.body ? (
        <p className="whitespace-pre-wrap break-words text-sm">{notice.body}</p>
      ) : null}
      <p className="text-xs text-muted">
        {dayText(notice.at)} by{" "}
        <Link
          className="underline"
          params={{ pubkey: notice.author }}
          to="/u/$pubkey"
        >
          {nameOf(profiles, notice.author)}
        </Link>
      </p>
    </article>
  );
}
