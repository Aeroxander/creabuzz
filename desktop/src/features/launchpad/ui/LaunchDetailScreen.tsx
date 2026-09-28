import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useDeleteLaunchMutation,
  useIsLaunchFounder,
  useLaunchQuery,
  usePublishLaunchMirrorMutation,
} from "@/features/launchpad/hooks";
import {
  launchFollowKey,
  useFollowedLaunches,
} from "@/features/launchpad/lib/followedLaunches";
import { effectiveLaunchStage } from "@/features/launchpad/lib/launchpadStatus";
import { LaunchManagePanel } from "@/features/launchpad/ui/LaunchManagePanel";
import { LaunchOverviewPanel } from "@/features/launchpad/ui/LaunchOverviewPanel";
import { MyBidsPanel } from "@/features/launchpad/ui/MyBidsPanel";
import { LaunchProposalsPanel } from "@/features/launchpad/ui/LaunchProposalsPanel";
import { TrustGateCard } from "@/features/launchpad/ui/TrustGateCard";
import { LaunchStageBadge } from "@/features/launchpad/ui/LaunchStageBadge";
import { LaunchTreasuryPanel } from "@/features/launchpad/ui/LaunchTreasuryPanel";
import { LaunchUpdatesPanel } from "@/features/launchpad/ui/LaunchUpdatesPanel";
import { PostUpdateDialog } from "@/features/launchpad/ui/PostUpdateDialog";
import { BidOnWebDialog } from "@/features/launchpad/ui/BidOnWebDialog";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { cn } from "@/shared/lib/cn";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { ArrowLeft, Star } from "lucide-react";

export function LaunchDetailScreen({
  launchId,
  author,
}: {
  launchId: string;
  author: string | undefined;
}) {
  const { launch, isLoading } = useLaunchQuery(launchId, author);
  const isFounder = useIsLaunchFounder(launch);
  const relayOrigin = getCachedRelayOrigin();
  const { followed, toggle } = useFollowedLaunches(relayOrigin);
  const { goLaunchpad } = useAppNavigation();
  const mirrorMutation = usePublishLaunchMirrorMutation();
  const deleteMutation = useDeleteLaunchMutation();
  const [bidOpen, setBidOpen] = React.useState(false);
  const [updateOpen, setUpdateOpen] = React.useState(false);

  const followKey = launch
    ? launchFollowKey(launch.record.author, launch.record.id)
    : "";
  const isFollowed = followed.has(followKey);

  const handlePostUpdate = React.useCallback(
    async (input: {
      title: string;
      body: string;
      channelId: string | null;
    }) => {
      if (!launch) return;
      try {
        await mirrorMutation.mutateAsync({
          kind: KIND_LAUNCH_UPDATE,
          author: launch.record.author,
          launchId: launch.record.id,
          content: { title: input.title, body: input.body },
        });
        if (input.channelId) {
          const { relayClient } = await import("@/shared/api/relayClient");
          await relayClient.sendMessage(
            input.channelId,
            `**${input.title}**\n\n${input.body}`,
          );
        }
        toast.success("Update published.");
        setUpdateOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Publishing the update failed.",
        );
      }
    },
    [launch, mirrorMutation],
  );

  if (isLoading || !launch) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        {isLoading ? "Loading launch…" : "Launch not found."}
      </div>
    );
  }

  const stage = effectiveLaunchStage(launch);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border/60 px-5 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <button
            aria-label="Back to launchpad"
            onClick={() => void goLaunchpad()}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            type="button"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold leading-tight tracking-tight">
                {launch.record.name}
              </h2>
              <LaunchStageBadge stage={stage} />
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {launch.record.pitch || "No pitch yet."}
            </p>
          </div>
          <button
            aria-label={isFollowed ? "Unfollow launch" : "Follow launch"}
            aria-pressed={isFollowed}
            onClick={() => toggle(followKey)}
            className={cn(
              "rounded-lg p-2",
              isFollowed
                ? "text-amber-500"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            type="button"
          >
            <Star
              className="h-4 w-4"
              fill={isFollowed ? "currentColor" : "none"}
            />
          </button>
          <Button onClick={() => setBidOpen(true)} size="sm" type="button">
            Back this launch
          </Button>
          {isFounder ? (
            <Button
              onClick={() => setUpdateOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Post update
            </Button>
          ) : null}
        </div>
      </header>

      <Tabs
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        defaultValue="overview"
      >
        <div className="shrink-0 border-b border-border/60 px-5">
          <TabsList aria-label="Launch sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="updates">
              Updates ({launch.updates.length})
            </TabsTrigger>
            <TabsTrigger value="discussion">Discussion</TabsTrigger>
            <TabsTrigger value="proposals">
              Proposals ({launch.proposals.length})
            </TabsTrigger>
            <TabsTrigger value="treasury">Treasury</TabsTrigger>
            <TabsTrigger value="bids">My bids</TabsTrigger>
            {isFounder ? (
              <TabsTrigger value="manage">Manage</TabsTrigger>
            ) : null}
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <TabsContent value="overview">
            {/* The TrustGraph surface: gate state, published roots, the graph. */}
            <TrustGateCard launch={launch} />
            <LaunchOverviewPanel launch={launch} />
          </TabsContent>
          <TabsContent value="updates">
            <LaunchUpdatesPanel launch={launch} />
          </TabsContent>
          <TabsContent value="discussion">
            <DiscussionPanel
              launchId={launch.record.id}
              channels={launch.record.channels}
            />
          </TabsContent>
          <TabsContent value="proposals">
            <LaunchProposalsPanel launch={launch} />
          </TabsContent>
          <TabsContent value="treasury">
            <LaunchTreasuryPanel launch={launch} isFounder={isFounder} />
          </TabsContent>
          <TabsContent value="bids">
            <MyBidsPanel launch={launch} relayOrigin={relayOrigin} />
          </TabsContent>
          {isFounder ? (
            <TabsContent value="manage">
              <LaunchManagePanel
                launch={launch}
                isDeleting={deleteMutation.isPending}
                onDelete={async () => {
                  try {
                    await deleteMutation.mutateAsync(launch);
                    toast.success("Launch removed from the directory.");
                    void goLaunchpad();
                  } catch (err) {
                    toast.error(
                      err instanceof Error
                        ? err.message
                        : "Deleting the launch failed.",
                    );
                  }
                }}
              />
            </TabsContent>
          ) : null}
        </div>
      </Tabs>

      <BidOnWebDialog
        launch={launch}
        onOpenChange={setBidOpen}
        open={bidOpen}
        relayOrigin={relayOrigin}
      />
      {isFounder ? (
        <PostUpdateDialog
          isPublishing={mirrorMutation.isPending}
          onPublish={handlePostUpdate}
          onOpenChange={setUpdateOpen}
          open={updateOpen}
          channels={launch.record.channels}
        />
      ) : null}
    </div>
  );
}

function DiscussionPanel({
  launchId,
  channels,
}: {
  launchId: string;
  channels: string[];
}) {
  const { goChannel } = useAppNavigation();
  if (channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No community channels linked yet. Founders link channels from the Manage
        tab — announcements and discussion live in the community, not here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Discussion for <span className="font-medium">{launchId}</span> happens
        in these community channels:
      </p>
      <ul className="flex flex-col gap-2">
        {channels.map((channelId) => (
          <li key={channelId}>
            <button
              className="w-full rounded-xl border border-border/70 bg-card/60 px-4 py-2.5 text-left text-sm transition-colors hover:bg-card"
              onClick={() => void goChannel(channelId)}
              type="button"
            >
              <span className="font-medium">#{channelId.slice(0, 8)}…</span>
              <span className="ml-2 text-2xs text-muted-foreground">
                Open in community →
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
