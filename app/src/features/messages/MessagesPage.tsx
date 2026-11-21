import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { BackHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { nameOf, pictureOf, useProfiles } from "../../lib/profiles";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { MessageServerCard } from "./MessageServerCard";
import { useConversations } from "./use-messages";

/** Private conversations, newest first. Only the two people in one can read it. */
export function MessagesPage() {
  const { pubkey, locked } = useAccount();
  const conversations = useConversations({ open: true });
  const list = conversations.data ?? [];
  const profiles = useProfiles(list.map((c) => c.peer)).data;
  return (
    <main className="screen mx-auto flex max-w-lg flex-col gap-4">
      <BackHeader title="Messages" />
      {pubkey ? <MessageServerCard /> : null}
      {!pubkey ? (
        <EmptyState title="Sign up to send messages" />
      ) : locked ? (
        <EmptyState title="Unlock to read your messages">
          Your messages open with your passkey. Use Unlock at the top.
        </EmptyState>
      ) : conversations.isPending ? (
        <Card className="h-24 animate-pulse" tone="plain" />
      ) : conversations.isError ? (
        <EmptyState
          action={
            <Button
              onClick={() => void conversations.refetch()}
              variant="secondary"
            >
              Try again
            </Button>
          }
          title="Messages could not be read"
        >
          {readFailureWords(conversations.error).text}
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<MessageSquare size={28} />}
          testId="messages-empty"
          title="No messages yet"
        >
          Open someone's profile and press Message to start one.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="conversations">
          {list.map((conversation) => {
            const name = nameOf(profiles, conversation.peer);
            const mine = conversation.last.from === pubkey;
            return (
              <li key={conversation.peer}>
                <Link
                  className="plain flex items-center gap-3 rounded-xl px-3 py-3 hover:brightness-110"
                  data-testid="conversation"
                  params={{ peer: conversation.peer }}
                  to="/you/messages/$peer"
                >
                  <Avatar
                    name={name}
                    picture={pictureOf(profiles, conversation.peer)}
                    pubkey={conversation.peer}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{name}</span>
                    <span className="block truncate text-sm text-muted">
                      {mine ? "You: " : ""}
                      {conversation.last.content}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {relativeTime(conversation.last.at)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
