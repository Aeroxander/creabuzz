import { ArrowLeft, MessagesSquare, Users } from "lucide-react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  normalizeRelayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { useCommunities } from "../use-communities";
import { useChannels } from "@/features/channels/use-channels";
import {
  ChannelSidebar,
  ChannelSidebarLoading,
} from "@/features/channels/ui/ChannelSidebar";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";

/**
 * Public page for one community (`/c/<host>`). The displayed metadata comes
 * from the unauthenticated directory; joining stores the community relay URL
 * locally (localStorage) and reloads into the full client.
 */
export function CommunityHomePage() {
  const { host } = useParams({ from: "/c/$host" });
  const search = useSearch({ from: "/c/$host" });
  const { data } = useCommunities();
  const channels = useChannels();
  const entry = data?.communities.find((c) => c.host === host);

  const [selectedChannel, setSelectedChannel] = useState<string | null>(() =>
    typeof search.channel === "string" ? search.channel : null,
  );
  const activeChannel = useMemo(
    () => channels.data?.find((c) => c.id === selectedChannel) ?? null,
    [channels.data, selectedChannel],
  );

  const hostName = entry?.name || host;
  const icon = entry?.icon;
  const memberCount = entry?.member_count ?? 0;

  const wsUrl = normalizeRelayWsUrl(host.startsWith("http") ? host : host);
  const deepLink = `buzz://connect?relay=${encodeURIComponent(wsUrl)}`;

  const joinInBrowser = () => {
    setStoredRelayWsUrl(wsUrl);
    window.location.reload();
  };

  if (activeChannel) {
    return (
      <div className="flex h-full min-h-0 w-full flex-1">
        <ChannelSidebar
          channels={channels.data ?? []}
          selectedId={activeChannel.id}
          onSelect={(id) => setSelectedChannel(id)}
        />
        <ChannelTimeline channel={activeChannel} />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-1 items-start justify-center bg-[#F3F3F3] px-4 py-10 dark:bg-[#171717]">
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
          {channels.isSuccess && channels.data && channels.data.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-black/70 dark:text-white/70">
                <MessagesSquare className="h-4 w-4" /> Open channels
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {channels.data.map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => setSelectedChannel(channel.id)}
                    className="flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-left text-sm text-black hover:border-black/25 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:border-white/25"
                    data-testid={`open-channel-${channel.name}`}
                  >
                    <MessagesSquare className="h-4 w-4 text-black/40 dark:text-white/40" />
                    <span className="truncate">{channel.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
