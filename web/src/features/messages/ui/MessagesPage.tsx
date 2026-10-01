import { Link, useNavigate } from "@tanstack/react-router";
import { PenLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { parseEntity } from "@/shared/lib/nip19";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { useUserSearch } from "../../feed/use-discover";
import { useProfiles, useViewerPubkey } from "../../feed/use-feed";
import { useContacts } from "../../feed/use-social";
import { Avatar, displayNameOf } from "../../feed/ui/Avatar";
import { FeedShell } from "../../feed/ui/FeedShell";
import { Message } from "../../feed/ui/Message";
import { TimelineSkeleton } from "../../feed/ui/Timeline";
import {
  useDirectMessages,
  useDmRelayList,
  usePublishDmRelayList,
} from "../use-messages";

function NewMessage({ viewer }: { viewer: string | null }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const contacts = useContacts(viewer).data ?? [];
  const q = query.trim();
  const direct = parseEntity(q);
  const search = useUserSearch(q);
  const contactProfiles = useProfiles(contacts.slice(0, 100)).data;

  const matches = [
    ...(direct?.type === "pubkey" ? [direct.pubkey] : []),
    ...[...(contactProfiles?.values() ?? [])]
      .filter((p) =>
        q === ""
          ? true
          : [p.name, p.displayName].some((n) =>
              n?.toLowerCase().includes(q.toLowerCase()),
            ),
      )
      .map((p) => p.pubkey),
    ...(search.data ?? []).map((p) => p.pubkey),
  ].filter((pk, i, all) => pk !== viewer && all.indexOf(pk) === i);
  const profiles = useProfiles(matches).data;

  return (
    <div className="border-b p-4">
      <label htmlFor="dm-recipient" className="sr-only">
        Send a message to
      </label>
      <input
        id="dm-recipient"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Message someone — search a name or paste an npub"
        className="h-11 w-full rounded-full bg-muted/60 px-4 text-[15px] outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
      />
      {(q !== "" || contacts.length > 0) && (
        <ul className="mt-2 max-h-72 overflow-y-auto">
          {matches.slice(0, 8).map((pk) => (
            <li key={pk}>
              <button
                type="button"
                onClick={() =>
                  navigate({ to: "/messages/$peer", params: { peer: pk } })
                }
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-foreground/5"
              >
                <Avatar
                  pubkey={pk}
                  profile={profiles?.get(pk)}
                  className="h-9 w-9"
                />
                <span className="min-w-0 leading-5">
                  <span className="block truncate font-bold">
                    {displayNameOf(pk, profiles?.get(pk))}
                  </span>
                  {profiles?.get(pk)?.name && (
                    <span className="block truncate text-sm text-muted-foreground">
                      @{profiles?.get(pk)?.name}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RelayListBanner({ viewer }: { viewer: string }) {
  const hasList = useDmRelayList(viewer);
  const publish = usePublishDmRelayList();
  if (hasList.isLoading || hasList.data !== false) return null;
  return (
    <div className="flex items-center gap-3 border-b bg-primary/5 px-4 py-3">
      <p className="flex-1 text-[15px] leading-5">
        Let people on other Nostr apps message you here. This publishes a public
        note saying you receive DMs on this relay.
      </p>
      <Button
        size="sm"
        className="rounded-full px-4 font-bold"
        disabled={publish.isPending}
        onClick={() =>
          publish.mutate(undefined, {
            onSuccess: () =>
              toast.success("Done — other apps can now reach you here"),
            onError: (e) => toast.error(e.message),
          })
        }
      >
        Turn on
      </Button>
    </div>
  );
}

export function MessagesPage() {
  const viewer = useViewerPubkey();
  const conversations = useDirectMessages(viewer);
  const profiles = useProfiles(
    (conversations.data ?? []).map((c) => c.peer),
  ).data;
  const [composing, setComposing] = useState(false);

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 flex h-[53px] items-center justify-between border-b bg-background/85 px-4 backdrop-blur">
        <h1 className="text-xl font-bold">Messages</h1>
        {viewer && (
          <button
            type="button"
            aria-label="New message"
            aria-pressed={composing}
            onClick={() => setComposing((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-foreground/10"
          >
            <PenLine className="h-5 w-5" />
          </button>
        )}
      </div>

      {!viewer ? (
        <Message
          title="Sign in to message"
          body="Direct messages are end-to-end encrypted with your key."
        />
      ) : (
        <>
          <RelayListBanner viewer={viewer} />
          {composing && <NewMessage viewer={viewer} />}
          {conversations.isLoading ? (
            <TimelineSkeleton />
          ) : conversations.isError ? (
            <Message
              title="Couldn’t load messages"
              body={conversations.error.message}
            />
          ) : !conversations.data?.length ? (
            <Message
              title="Welcome to your inbox"
              body="Messages are end-to-end encrypted (NIP-17). Start one with the pencil above."
            />
          ) : (
            conversations.data.map((c) => {
              const profile = profiles?.get(c.peer);
              return (
                <Link
                  key={c.peer}
                  to="/messages/$peer"
                  params={{ peer: c.peer }}
                  className="flex gap-3 border-b px-4 py-3 transition-colors hover:bg-foreground/[0.04]"
                >
                  <Avatar pubkey={c.peer} profile={profile} />
                  <div className="min-w-0 flex-1 leading-5">
                    <div className="flex items-baseline gap-1">
                      <span className="truncate font-bold">
                        {displayNameOf(c.peer, profile)}
                      </span>
                      {profile?.name && (
                        <span className="truncate text-muted-foreground">
                          @{profile.name}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        · {shortRelativeTime(c.last.at)}
                      </span>
                    </div>
                    <p className="truncate text-[15px] text-muted-foreground">
                      {c.last.from === viewer ? "You: " : ""}
                      {c.last.content}
                    </p>
                  </div>
                </Link>
              );
            })
          )}
        </>
      )}
    </FeedShell>
  );
}
