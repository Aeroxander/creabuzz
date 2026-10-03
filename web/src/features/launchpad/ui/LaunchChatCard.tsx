/**
 * The launch's chat rooms on the launch page.
 *
 * Three rooms, each with the one action its viewer can take: join the open
 * supporters room, open a room they are in, wait for the founder to admit a
 * bid-holder into the backers room, or (founder) create what is missing.
 */

import { Link } from "@tanstack/react-router";
import { Lock, MessagesSquare } from "lucide-react";
import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { isIdea } from "../lib/idea";
import {
  hasChat,
  missingRooms,
  type RoomKey,
  type RoomRow,
} from "../lib/launch-chat";
import type { Launch } from "../models";
import {
  useAdmitBackers,
  useChatRows,
  useCreateChatRooms,
  useJoinRoom,
} from "../use-launch-chat";

const ROOM_COPY: Record<RoomKey, { title: string; blurb: string }> = {
  supporters: {
    title: "Supporters",
    blurb: "Open to anyone who is excited about this project.",
  },
  backers: {
    title: "Backers",
    blurb: "For people who backed this launch. The founder lets you in.",
  },
  team: { title: "Team", blurb: "Private to the people building it." },
};

function communityHost(): string {
  try {
    return new URL(relayWsUrl()).host;
  } catch {
    return "";
  }
}

function OpenRoom({ row }: { row: RoomRow }) {
  return (
    <Button asChild size="sm">
      <Link
        data-testid={`launch-chat-open-${row.room}`}
        params={{ host: communityHost() }}
        search={{ channel: row.id }}
        to="/c/$host"
      >
        Open
      </Link>
    </Button>
  );
}

function JoinRoom({ row }: { row: RoomRow }) {
  const join = useJoinRoom(row.id);
  const onJoin = async () => {
    if (!existingUserPubkey()) {
      toast.error("Create your identity from the profile menu to join.");
      return;
    }
    try {
      await join.mutateAsync();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not join. Try again.",
      );
    }
  };
  return (
    <Button
      data-testid={`launch-chat-join-${row.room}`}
      disabled={join.isPending}
      onClick={() => void onJoin()}
      size="sm"
    >
      {join.isPending ? "Joining…" : "Join"}
    </Button>
  );
}

function RoomAction({ row }: { row: RoomRow }) {
  switch (row.standing) {
    case "member":
      return <OpenRoom row={row} />;
    case "join":
      return <JoinRoom row={row} />;
    case "pending":
      return (
        <span
          className="rounded-full bg-foreground/10 px-3 py-1 text-xs font-semibold"
          data-testid="launch-chat-pending"
        >
          Waiting for the founder
        </span>
      );
    case "locked":
      return (
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          data-testid="launch-chat-locked"
        >
          <Lock aria-hidden className="h-3 w-3" /> Back this launch to join
        </span>
      );
  }
}

function AdmitBackers({ launch }: { launch: Launch }) {
  const { waiting, admit } = useAdmitBackers(launch);
  if (waiting.length === 0) return null;
  const onAdmit = async () => {
    try {
      const admitted = await admit.mutateAsync(waiting);
      toast.success(
        admitted.length === 1
          ? "1 backer admitted."
          : `${admitted.length} backers admitted.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not admit everyone. Try again.",
      );
    }
  };
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-primary/10 px-3 py-2"
      data-testid="launch-chat-admit"
    >
      <p className="text-sm">
        {waiting.length === 1
          ? `${truncatePubkey(waiting[0])} backed this launch and is waiting to join.`
          : `${waiting.length} backers are waiting to join.`}
      </p>
      <Button
        data-testid="launch-chat-admit-button"
        disabled={admit.isPending}
        onClick={() => void onAdmit()}
        size="sm"
      >
        {admit.isPending ? "Admitting…" : "Admit"}
      </Button>
    </div>
  );
}

export function LaunchChatCard({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const { chat } = launch.record;
  const sale = !isIdea(launch.record);
  const create = useCreateChatRooms(launch, { sale });
  const { rows } = useChatRows(launch);
  const missing = isFounder ? missingRooms(chat, { sale }) : [];

  const onCreate = async () => {
    try {
      const rooms = await create.mutateAsync();
      toast.success(
        rooms.failedRooms.length > 0 || rooms.failedTeam.length > 0
          ? "Some chat rooms are ready. A few could not be set up yet; try again."
          : "Chat rooms created.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not create the chat rooms. Try again.",
      );
    }
  };

  if (!hasChat(chat) && missing.length === 0) return null;
  return (
    <Card className="p-4" data-testid="launch-chat">
      <div className="flex items-start gap-3">
        <MessagesSquare
          aria-hidden
          className="mt-0.5 h-5 w-5 text-primary-ink"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">Chat</h2>
          <ul className="mt-2 divide-y divide-border/60">
            {rows.map((row) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 py-2"
                data-testid={`launch-chat-row-${row.room}`}
                key={row.room}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {ROOM_COPY[row.room].title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ROOM_COPY[row.room].blurb}
                  </p>
                </div>
                <RoomAction row={row} />
              </li>
            ))}
          </ul>
          {missing.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {hasChat(chat)
                  ? "Some rooms are not set up yet."
                  : "Give your team a private room and your supporters one of their own."}
              </p>
              <Button
                data-testid="launch-chat-create"
                disabled={create.isPending}
                onClick={() => void onCreate()}
                size="sm"
                variant="outline"
              >
                {create.isPending ? "Creating…" : "Create chat rooms"}
              </Button>
            </div>
          ) : null}
          {isFounder ? <AdmitBackers launch={launch} /> : null}
        </div>
      </div>
    </Card>
  );
}
