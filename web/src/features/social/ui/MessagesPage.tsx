import { Link, useNavigate } from "@tanstack/react-router";
import { PenLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { parseEntity } from "../lib/entity";
import { useUserSearch } from "../use-discovery";
import {
  useConversations,
  useHasDmRelayList,
  usePublishDmRelayList,
} from "../use-messages";
import { usePeople } from "../use-people";
import { useFollowing } from "../use-social-data";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

function NewMessage({ me }: { me: string }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const following = useFollowing(me).data ?? [];
  const q = query.trim();
  const direct = parseEntity(q);
  const found = useUserSearch(q);
  const followedPeople = usePeople(following.slice(0, 100));

  const matches = [
    ...(direct?.type === "pubkey" ? [direct.pubkey] : []),
    ...Object.entries(followedPeople)
      .filter(([, p]) =>
        q === ""
          ? true
          : [p.name, p.display_name].some((n) =>
              n?.toLowerCase().includes(q.toLowerCase()),
            ),
      )
      .map(([pubkey]) => pubkey),
    ...Object.keys(found.data ?? {}),
  ].filter((pk, i, all) => pk !== me && all.indexOf(pk) === i);
  const people = usePeople(matches);

  return (
    <div
      className="border-b border-black/10 p-4 dark:border-white/10"
      data-testid="social-new-message"
    >
      <label className="sr-only" htmlFor="social-dm-recipient">
        Send a message to
      </label>
      <input
        className="h-10 w-full rounded-full bg-black/5 px-4 text-sm text-black outline-none placeholder:text-black/50 focus:ring-1 focus:ring-primary dark:bg-white/10 dark:text-white dark:placeholder:text-white/50"
        data-testid="social-dm-recipient"
        id="social-dm-recipient"
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for someone, or paste their public key"
        value={query}
      />
      <ul className="mt-2 max-h-72 overflow-y-auto">
        {matches.slice(0, 8).map((pubkey) => (
          <li key={pubkey}>
            <button
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-black/5 dark:hover:bg-white/10"
              onClick={() =>
                void navigate({
                  to: "/social/messages/$peer",
                  params: { peer: pubkey },
                })
              }
              type="button"
            >
              <UserAvatar
                avatarUrl={people[pubkey]?.picture ?? null}
                displayName={resolveUserName(people[pubkey], pubkey)}
              />
              <span className="min-w-0 text-sm leading-5">
                <span className="block truncate font-bold text-black dark:text-white">
                  {resolveUserName(people[pubkey], pubkey)}
                </span>
                <span className="block truncate text-black/60 dark:text-white/60">
                  {resolveUserSecondaryName(people[pubkey], pubkey)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReceiveFromOtherAppsBanner() {
  const has = useHasDmRelayList();
  const publish = usePublishDmRelayList();
  if (has.isLoading || has.data !== false) return null;
  return (
    <div
      className="flex items-center gap-3 border-b border-black/10 bg-sky-500/5 px-4 py-3 dark:border-white/10"
      data-testid="social-dm-relay-banner"
    >
      <p className="flex-1 text-sm text-black dark:text-white">
        Let people on other Nostr apps message you here. This publishes a public
        note saying you receive direct messages on this relay.
      </p>
      <Button
        className="rounded-full px-4 font-semibold"
        disabled={publish.isPending}
        onClick={() =>
          publish.mutate(undefined, {
            onSuccess: () => toast.success("Other apps can now reach you here"),
            onError: (error) =>
              toast.error(
                error instanceof Error ? error.message : "That didn't work.",
              ),
          })
        }
        size="sm"
        type="button"
      >
        Turn on
      </Button>
    </div>
  );
}

/** Your private conversations: end-to-end encrypted, readable by other Nostr apps. */
export function MessagesPage() {
  const me = existingUserPubkey();
  const conversations = useConversations();
  const people = usePeople((conversations.data ?? []).map((c) => c.peer));
  const [composing, setComposing] = useState(false);

  return (
    <SocialShell>
      <PageBar title="Messages">
        {me ? (
          <button
            aria-label="New message"
            aria-pressed={composing}
            className="absolute right-3 top-1.5 flex h-9 w-9 items-center justify-center rounded-full text-black hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
            data-testid="social-new-message-button"
            onClick={() => setComposing((v) => !v)}
            type="button"
          >
            <PenLine aria-hidden className="h-5 w-5" />
          </button>
        ) : null}
      </PageBar>
      {!me ? (
        <EmptyState title="Sign in to send messages">
          Messages are end-to-end encrypted with your key.
        </EmptyState>
      ) : (
        <>
          <ReceiveFromOtherAppsBanner />
          {composing ? <NewMessage me={me} /> : null}
          {conversations.isLoading ? (
            <TimelineSkeleton />
          ) : conversations.isError ? (
            <EmptyState title="Couldn't load your messages">
              {conversations.error instanceof Error
                ? conversations.error.message
                : "Try again."}
            </EmptyState>
          ) : !conversations.data?.length ? (
            <EmptyState
              testId="social-messages-empty"
              title="Your inbox is empty"
            >
              Messages are end-to-end encrypted. Start one with the pencil
              above.
            </EmptyState>
          ) : (
            conversations.data.map((c) => {
              const profile = people[c.peer];
              const name = resolveUserName(profile, c.peer);
              return (
                <Link
                  className="flex gap-3 border-b border-black/10 px-4 py-3 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]"
                  data-testid="social-conversation"
                  key={c.peer}
                  params={{ peer: c.peer }}
                  to="/social/messages/$peer"
                >
                  <UserAvatar
                    avatarUrl={profile?.picture ?? null}
                    className="h-10 w-10"
                    displayName={name}
                  />
                  <span className="min-w-0 flex-1 text-sm leading-5">
                    <span className="flex items-baseline gap-1">
                      <span className="truncate font-bold text-black dark:text-white">
                        {name}
                      </span>
                      <span className="text-black/60 dark:text-white/60">
                        · {shortRelativeTime(c.last.at)}
                      </span>
                    </span>
                    <span className="block truncate text-black/60 dark:text-white/60">
                      {c.last.from === me ? "You: " : ""}
                      {c.last.content}
                    </span>
                  </span>
                </Link>
              );
            })
          )}
        </>
      )}
    </SocialShell>
  );
}
