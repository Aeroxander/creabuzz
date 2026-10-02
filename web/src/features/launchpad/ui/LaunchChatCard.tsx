/**
 * The launch's chat rooms on the launch page.
 *
 * Everyone sees what the rooms are; only people inside get a way in. A backer
 * who has recorded a bid waits for the founder to admit them (private rooms
 * reject self-join), and the founder sees those backers here with one button.
 */

import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { toast } from "sonner";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { hasChat, roomToOpen } from "../lib/launch-chat";
import type { Launch } from "../models";
import {
  useAdmitBackers,
  useChatAccess,
  useCreateChatRooms,
} from "../use-launch-chat";

function communityHost(): string {
  try {
    return new URL(relayWsUrl()).host;
  } catch {
    return "";
  }
}

function OpenChatLink({ room }: { room: string }) {
  const host = communityHost();
  return (
    <Button asChild size="sm">
      <Link
        data-testid="launch-chat-open"
        params={{ host }}
        search={{ channel: room }}
        to="/c/$host"
      >
        Open chat
      </Link>
    </Button>
  );
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
  const create = useCreateChatRooms(launch);
  const { access, visibleRooms, loading } = useChatAccess(launch);
  const { chat } = launch.record;
  const onCreate = async () => {
    try {
      const rooms = await create.mutateAsync();
      toast.success(
        rooms.failedTeam.length > 0
          ? "Chat rooms created. Some team members could not be added yet."
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
  if (!hasChat(chat)) {
    if (!isFounder) return null;
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-bold">Chat rooms</h2>
          <p className="text-xs text-muted-foreground">
            Give your team a private room and your backers one of their own.
          </p>
        </div>
        <Button
          data-testid="launch-chat-create"
          disabled={create.isPending}
          onClick={() => void onCreate()}
          size="sm"
          variant="outline"
        >
          {create.isPending ? "Creating…" : "Create chat rooms"}
        </Button>
      </Card>
    );
  }
  const room = roomToOpen(chat, visibleRooms);
  return (
    <Card className="p-4" data-testid="launch-chat">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <MessagesSquare
            aria-hidden
            className="mt-0.5 h-5 w-5 text-primary-ink"
          />
          <div>
            <h2 className="text-sm font-bold">Chat</h2>
            <p className="text-xs text-muted-foreground">
              {access === "member"
                ? "Talk with the team and other backers."
                : access === "pending"
                  ? "Your bid is recorded. The founder will let you in."
                  : "Backers and the team talk here. Back this launch to join."}
            </p>
          </div>
        </div>
        {room ? (
          <OpenChatLink room={room} />
        ) : loading ? null : access === "pending" ? (
          <span
            className="rounded-full bg-foreground/10 px-3 py-1 text-xs font-semibold"
            data-testid="launch-chat-pending"
          >
            Waiting for the founder
          </span>
        ) : null}
      </div>
      {isFounder ? <AdmitBackers launch={launch} /> : null}
    </Card>
  );
}
