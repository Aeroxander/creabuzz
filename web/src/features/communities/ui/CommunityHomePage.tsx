import { ArrowLeft, Users } from "lucide-react";
import { Link, useParams, useSearch } from "@tanstack/react-router";

import {
  normalizeRelayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { useCommunities } from "../use-communities";
import { useChannels } from "@/features/channels/use-channels";
import { ChannelSidebarLoading } from "@/features/channels/ui/ChannelSidebar";
import { CommunityShell } from "@/features/channels/ui/CommunityShell";

/**
 * Public page for one community (`/c/<host>`). Communities with open
 * channels open directly into the app shell (sidebar + search + timeline);
 * empty communities show their public card with join/connect CTAs.
 */
export function CommunityHomePage() {
  const { host } = useParams({ from: "/c/$host" });
  const search = useSearch({ from: "/c/$host" });
  const { data } = useCommunities();
  const channels = useChannels();
  const entry = data?.communities.find((c) => c.host === host);

  const hostName = entry?.name || host;
  const icon = entry?.icon;
  const memberCount = entry?.member_count ?? 0;

  const wsUrl = normalizeRelayWsUrl(host);
  const deepLink = `buzz://connect?relay=${encodeURIComponent(wsUrl)}`;

  const joinInBrowser = () => {
    setStoredRelayWsUrl(wsUrl);
    window.location.reload();
  };

  if (channels.isSuccess && channels.data && channels.data.length > 0) {
    const initialChannelId =
      typeof search.channel === "string" ? search.channel : undefined;
    return (
      <div className="flex h-dvh min-h-0 w-full flex-1">
        <CommunityShell
          channels={channels.data}
          initialChannelId={initialChannelId}
          host={host}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 items-start justify-center overflow-y-auto bg-[#F3F3F3] px-4 py-10 dark:bg-[#171717]">
      <div className="w-full max-w-2xl">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> All communities
        </Link>

        <div className="rounded-xl border border-black/10 bg-white p-8 shadow-xs dark:border-white/10 dark:bg-white/5">
          <div className="flex items-center gap-4">
            {icon ? (
              <img
                alt=""
                src={icon}
                className="h-16 w-16 rounded-xl object-cover"
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
              <p className="truncate text-sm text-black/50 dark:text-white/50">
                {host}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-black/50 dark:text-white/50">
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
              <a href={deepLink}>Open in Buzz</a>
            </Button>
          </div>

          <p className="mt-4 text-xs text-black/45 dark:text-white/45">
            Joining doesn't require an account here — Buzz creates a local
            identity only when you post or join privately.
          </p>

          {channels.isLoading && <ChannelSidebarLoading />}
        </div>
      </div>
    </div>
  );
}
