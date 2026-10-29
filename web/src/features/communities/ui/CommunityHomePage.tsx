import { ArrowLeft, Ban, Lock, Users } from "lucide-react";
import { Link, useParams, useSearch } from "@tanstack/react-router";

import {
  normalizeRelayWsUrl,
  relayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import { ServerImage } from "@/shared/ui/ServerImage";
import { Button } from "@/shared/ui/button";
import { looksLikeBanned, looksLikeNotAMember } from "../lib/access";
import { useCommunities } from "../use-communities";
import { useCommunityAccess } from "../use-access";
import { useChannels } from "@/features/channels/use-channels";
import { ChannelSidebarLoading } from "@/features/channels/ui/ChannelSidebar";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { desktopConnectDeepLink } from "@/shared/lib/desktop-deep-link";
import { CommunityShell } from "@/features/channels/ui/CommunityShell";

/**
 * Community entry (`/c/<host>`).
 *
 * Loading and failure are distinct states, not empty ones: a channel query that
 * fails must not be presented as "this community has no channels", because that
 * sends the visitor to the join button instead of letting them retry.
 *
 * The failure itself is also typed: a locked passkey cannot sign this relay's
 * NIP-42 challenge, and the page says so with the sign-in action inline
 * instead of reporting a private relay as a dead one.
 */
function CommunityLoadState({
  host,
  error,
  message,
  onRetry,
}: {
  host: string;
  error: unknown;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 dark:border-white/10 dark:bg-white/5">
        <QueryError
          description={`${host} did not answer the channel query.`}
          error={error}
          message={message}
          onRetry={onRetry}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="community-load-error"
          title="Couldn't load this community"
        />
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link to="/c">All communities</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * What someone sees when they open a community that is invite-only and they are not in it: that it is private, and
 * what to do, instead of a page that reads like the server is broken.
 */
function InviteOnlyNotice({
  host,
  onRetry,
}: {
  host: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
      <div
        className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 text-center dark:border-white/10 dark:bg-white/5"
        data-testid="community-invite-only"
      >
        <Lock className="mx-auto h-6 w-6 text-black/60 dark:text-white/60" />
        <h1 className="mt-3 text-lg font-semibold">
          This community is invite-only
        </h1>
        <p className="mt-1 break-all text-xs text-black/60 dark:text-white/60">
          {host}
        </p>
        <p className="mt-3 text-sm text-black/70 dark:text-white/70">
          Ask someone in it for an invite link, then open the link to join.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button
            data-testid="community-invite-only-retry"
            onClick={onRetry}
            variant="outline"
          >
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link to="/c">All communities</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a banned person sees instead of a page that reads like the server is broken. There is nothing for them to retry,
 * so there is no retry button.
 */
function BannedNotice({ host }: { host: string }) {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
      <div
        className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 text-center dark:border-white/10 dark:bg-white/5"
        data-testid="community-banned"
      >
        <Ban className="mx-auto h-6 w-6 text-black/60 dark:text-white/60" />
        <h1 className="mt-3 text-lg font-semibold">
          You are banned from this community
        </h1>
        <p className="mt-1 break-all text-xs text-black/60 dark:text-white/60">
          {host}
        </p>
        <p className="mt-3 text-sm text-black/70 dark:text-white/70">
          The people who run it have turned you away. If you think that is a
          mistake, ask one of them.
        </p>
        <div className="mt-4 flex justify-center">
          <Button asChild variant="outline">
            <Link to="/c">All communities</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Do two server addresses point at the same machine and port? */
function sameServer(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * Public page for one community (`/c/<host>`). Communities with open
 * channels open directly into the app shell (sidebar + search + timeline);
 * empty communities show their public card with join/connect CTAs, unless this
 * browser is already connected to it. Then there is nothing to join, and the
 * shell opens on its own prompt to start a project.
 */
export function CommunityHomePage() {
  const { host } = useParams({ from: "/c/$host" });
  const search = useSearch({ from: "/c/$host" });
  const { data } = useCommunities();
  const channels = useChannels();
  const access = useCommunityAccess();
  const entry = data?.communities.find((c) => c.host === host);

  const hostName = entry?.name || host;
  const icon = entry?.icon;
  const memberCount = entry?.member_count ?? 0;

  const wsUrl = normalizeRelayWsUrl(host);
  const deepLink = desktopConnectDeepLink(wsUrl);

  const joinInBrowser = () => {
    setStoredRelayWsUrl(wsUrl);
    window.location.reload();
  };

  if (channels.isLoading) {
    return (
      <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md">
          <ChannelSidebarLoading />
        </div>
      </div>
    );
  }

  if (channels.isError && looksLikeBanned(errorMessage(channels.error))) {
    return <BannedNotice host={host} />;
  }

  if (
    channels.isError &&
    access.data === "invite_only" &&
    looksLikeNotAMember(errorMessage(channels.error))
  ) {
    return (
      <InviteOnlyNotice host={host} onRetry={() => void channels.refetch()} />
    );
  }

  if (channels.isError) {
    return (
      <CommunityLoadState
        host={host}
        error={channels.error}
        message={
          // An archived community fails its reads by design; saying so turns a
          // mysterious error into an explanation.
          entry?.archived
            ? `This community is archived, so its channels are no longer served. ${errorMessage(channels.error)}`
            : errorMessage(channels.error)
        }
        onRetry={() => void channels.refetch()}
      />
    );
  }

  if (channels.channels.length > 0 || sameServer(relayWsUrl(), wsUrl)) {
    const initialChannelId =
      typeof search.channel === "string" ? search.channel : undefined;
    const initialMessageId =
      typeof search.message === "string" ? search.message : undefined;
    return (
      <div className="flex h-dvh min-h-0 w-full flex-1">
        <CommunityShell
          channels={channels.channels}
          initialChannelId={initialChannelId}
          initialMessageId={initialMessageId}
          initialView={
            search.view && search.view !== "channels" ? search.view : undefined
          }
          initialPage={search.page}
          initialWorkId={search.work}
          initialPostId={search.post}
          host={host}
          hasMoreChannels={channels.hasMoreChannels}
          loadingMoreChannels={channels.loadingMore}
          moreChannelsError={channels.moreError}
          onLoadMoreChannels={() => void channels.loadMoreChannels()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 items-start justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-2xl">
        <Link
          to="/c"
          className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> All communities
        </Link>

        <div className="rounded-xl border border-black/10 bg-white p-8 shadow-xs dark:border-white/10 dark:bg-white/5">
          <div className="flex items-center gap-4">
            {icon ? (
              <ServerImage
                alt=""
                src={icon}
                className="h-16 w-16 rounded-xl object-cover"
                unavailable="icon"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-black/5 text-3xl font-semibold text-black/60 dark:bg-white/10 dark:text-white/70">
                {hostName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold text-black dark:text-white">
                {hostName}
              </h1>
              <p className="truncate text-sm text-black/60 dark:text-white/60">
                {host}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-black/60 dark:text-white/60">
                <Users className="h-4 w-4" />
                {memberCount} member{memberCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <p className="mt-5 text-sm leading-relaxed text-black/70 dark:text-white/70">
            {entry?.description ||
              "Browse this community in your browser. Join to see channels, messages, repositories, and agents."}
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              onClick={joinInBrowser}
              className="bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
            >
              Join in browser
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-black/15 dark:border-white/15"
            >
              <a href={deepLink}>Open in Creaton</a>
            </Button>
          </div>

          <p className="mt-4 text-xs text-black/60 dark:text-white/60">
            Joining doesn't require an account here. Creaton creates a local
            identity only when you post or join privately.
          </p>
        </div>
      </div>
    </div>
  );
}
