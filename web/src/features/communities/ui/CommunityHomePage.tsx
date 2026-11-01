import { ArrowLeft, Ban, Lock, Users } from "lucide-react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  normalizeRelayWsUrl,
  relayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import { ServerImage } from "@/shared/ui/ServerImage";
import { Button } from "@/shared/ui/button";
import {
  asSentence,
  type BanNotice,
  banHeadline,
  banIn,
} from "@/shared/lib/refusal-text";
import { looksLikeBanned, looksLikeNotAMember } from "../lib/access";
import { checkServer, saveServerAddress } from "../lib/server-switch";
import { useCommunities } from "../use-communities";
import { useCommunityAccess } from "../use-access";
import { useChannels } from "@/features/channels/use-channels";
import { ChannelSidebarLoading } from "@/features/channels/ui/ChannelSidebar";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { desktopConnectDeepLink } from "@/shared/lib/desktop-deep-link";
import { DESKTOP_APP } from "@/shared/lib/desktop-app";
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
  description,
  error,
  message,
  onRetry,
}: {
  host: string;
  /** Plain words that replace "did not answer" when the page already knows why (an archived community). */
  description?: string;
  error: unknown;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 dark:border-white/10 dark:bg-white/5">
        <QueryError
          description={
            description ?? `${host} did not answer the channel query.`
          }
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
 * What a banned person sees instead of a page that reads like the server is broken: until when, and the moderator's
 * reason, when the server said them. There is nothing for them to retry, so there is no retry button.
 */
function BannedNotice({ host, ban }: { host: string; ban: BanNotice | null }) {
  const ends = ban?.ends ?? null;
  return (
    <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
      <div
        className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 text-center dark:border-white/10 dark:bg-white/5"
        data-testid="community-banned"
      >
        <Ban className="mx-auto h-6 w-6 text-black/60 dark:text-white/60" />
        <h1 className="mt-3 text-lg font-semibold">{banHeadline(ends)}</h1>
        <p className="mt-1 break-all text-xs text-black/60 dark:text-white/60">
          {host}
        </p>
        {ban?.reason ? (
          <p
            className="mt-3 break-words text-sm"
            data-testid="community-banned-reason"
          >
            Reason: {asSentence(ban.reason)}
          </p>
        ) : null}
        <p className="mt-3 text-sm text-black/70 dark:text-white/70">
          The people who run it have turned you away.
          {typeof ends === "number" ? " You can come back once it ends." : ""}
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
 * Public page for one community (`/c/<host>`). The community this browser is
 * connected to opens directly into the app shell (sidebar + search + timeline),
 * even with no rooms yet: there is nothing to join, and the shell opens on its
 * own prompt to start a project. Any other community shows its public card with
 * join/connect actions, whatever the connected server holds.
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

  // The page reloads onto the saved address, so a server that does not answer is never saved: the person stays here,
  // told why, with the button to try again. The check belongs to the address it was started on: moving to another
  // community's page, or leaving this one, stops it, so a late answer neither saves nor reloads, and its words are
  // never shown on another community's card.
  const [join, setJoin] = useState<{
    host: string;
    checking: boolean;
    problem: string | null;
  } | null>(null);
  const joinRun = useRef<{ host: string; controller: AbortController } | null>(
    null,
  );
  useEffect(() => {
    const forHost = host;
    return () => {
      const run = joinRun.current;
      if (run?.host !== forHost) return;
      run.controller.abort();
      joinRun.current = null;
    };
  }, [host]);
  const joinHere =
    join?.host === host ? join : { checking: false, problem: null };
  const joinInBrowser = async () => {
    joinRun.current?.controller.abort();
    const run = { host, controller: new AbortController() };
    joinRun.current = run;
    setJoin({ host, checking: true, problem: null });
    const check = await checkServer(wsUrl, { signal: run.controller.signal });
    if (joinRun.current !== run || run.controller.signal.aborted) return;
    joinRun.current = null;
    const problem = check.ok
      ? saveServerAddress(wsUrl, setStoredRelayWsUrl)
      : check.problem;
    if (problem) {
      setJoin({ host, checking: false, problem });
      return;
    }
    window.location.reload();
  };

  // The rooms, errors and refusals below are the CONNECTED server's answers. They describe `/c/<host>` only when that
  // host is the connected server; any other host is a different community, shown by its own card with the way to join
  // it (switching servers), never by this server's rooms under the other community's name.
  const here = sameServer(relayWsUrl(), wsUrl);

  if (here && channels.isLoading) {
    return (
      <div className="flex h-dvh min-h-0 w-full flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md">
          <ChannelSidebarLoading />
        </div>
      </div>
    );
  }

  if (
    here &&
    channels.isError &&
    looksLikeBanned(errorMessage(channels.error))
  ) {
    return (
      <BannedNotice ban={banIn(errorMessage(channels.error))} host={host} />
    );
  }

  if (
    here &&
    channels.isError &&
    access.data === "invite_only" &&
    looksLikeNotAMember(errorMessage(channels.error))
  ) {
    return (
      <InviteOnlyNotice host={host} onRetry={() => void channels.refetch()} />
    );
  }

  if (here && channels.isError) {
    return (
      <CommunityLoadState
        host={host}
        error={channels.error}
        description={
          // An archived community fails its reads by design; saying so turns a
          // mysterious error into an explanation. The error itself stays under Technical details.
          entry?.archived
            ? "This community is archived, so its channels are no longer served."
            : undefined
        }
        message={errorMessage(channels.error)}
        onRetry={() => void channels.refetch()}
      />
    );
  }

  if (here) {
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
              disabled={joinHere.checking}
              onClick={() => void joinInBrowser()}
              className="bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
            >
              Join this community
            </Button>
            {/* As on the invite page: a build without the desktop app links to nothing that would open. */}
            {DESKTOP_APP ? (
              <Button
                asChild
                variant="outline"
                className="border-black/15 dark:border-white/15"
              >
                <a href={deepLink}>Open in Creaton</a>
              </Button>
            ) : null}
          </div>

          <p
            aria-live="polite"
            className="mt-3 text-sm text-red-700 empty:hidden dark:text-red-300"
            data-testid="community-join-problem"
            role="status"
          >
            {joinHere.checking ? (
              <span className="text-black/60 dark:text-white/60">
                Checking {host}…
              </span>
            ) : (
              joinHere.problem
            )}
          </p>

          <p className="mt-4 text-xs text-black/60 dark:text-white/60">
            Joining doesn't require an account here. Creaton creates a local
            identity only when you post or join privately.
          </p>
        </div>
      </div>
    </div>
  );
}
