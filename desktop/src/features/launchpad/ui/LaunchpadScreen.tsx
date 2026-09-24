import { useQueryClient } from "@tanstack/react-query";
import { Rocket, Plus, Star } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  launchesQueryKey,
  useCreateLaunchMutation,
  useLaunchesQuery,
  type CreateLaunchInput,
} from "@/features/launchpad/hooks";
import {
  launchFollowKey,
  useFollowedLaunches,
} from "@/features/launchpad/lib/followedLaunches";
import { effectiveLaunchStage } from "@/features/launchpad/lib/launchpadStatus";
import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import type { Launch } from "@/features/launchpad/launchpadModels";
import { CreateLaunchDialog } from "@/features/launchpad/ui/CreateLaunchDialog";
import { RpcEndpointControl } from "@/features/launchpad/ui/RpcEndpointControl";
import { WalletCard } from "@/features/launchpad/ui/WalletCard";
import { AuctionProgressBar } from "@/features/launchpad/ui/LaunchAuctionProgress";
import { LaunchStageBadge } from "@/features/launchpad/ui/LaunchStageBadge";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { cn } from "@/shared/lib/cn";

type LaunchFilter = "all" | "mine" | "following";

export function LaunchpadScreen() {
  const { data, isLoading, error } = useLaunchesQuery();
  const queryClient = useQueryClient();
  const { goLaunch } = useAppNavigation();
  const identity = useIdentityQuery();
  const relayOrigin = getCachedRelayOrigin();
  const { followed, toggle } = useFollowedLaunches(relayOrigin);
  const createMutation = useCreateLaunchMutation();
  const [filter, setFilter] = React.useState<LaunchFilter>("all");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rpcUrl, setRpcUrl] = React.useState(() => getRpcEndpoint(relayOrigin));

  const launches = React.useMemo(() => data ?? [], [data]);
  const visible = launches.filter((launch) => {
    if (filter === "mine")
      return launch.record.author === identity.data?.pubkey;
    if (filter === "following")
      return followed.has(
        launchFollowKey(launch.record.author, launch.record.id),
      );
    return true;
  });
  const live = launches.filter((l) =>
    ["live", "funding"].includes(effectiveLaunchStage(l)),
  ).length;
  const graduated = launches.filter(
    (l) => effectiveLaunchStage(l) === "graduated",
  ).length;

  const handleCreate = React.useCallback(
    async (input: CreateLaunchInput) => {
      try {
        await createMutation.mutateAsync(input);
        toast.success("Launch published.");
        setCreateOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Publishing the launch failed.",
        );
      }
    },
    [createMutation],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border/60 px-5 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Rocket className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight tracking-tight">
              Launchpad
            </h2>
            <p className="text-sm text-muted-foreground">
              Discover raises to back — or launch your own DAO.
            </p>
          </div>
          <Button
            data-testid="launchpad-curate"
            onClick={() => setCreateOpen(true)}
            size="sm"
            type="button"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            New launch
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Stat label="Launches" value={launches.length} />
          <Stat label="Live now" value={live} />
          <Stat label="Graduated" value={graduated} />
          <RpcEndpointControl onEndpointSaved={setRpcUrl} />
          <WalletCard rpcUrl={rpcUrl} />
          <div
            className="ml-auto flex items-center gap-1"
            role="tablist"
            aria-label="Launch filter"
          >
            {(["all", "mine", "following"] as const).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-2xs font-medium uppercase tracking-wide",
                  filter === f
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted",
                )}
                type="button"
              >
                {f === "all" ? "All" : f === "mine" ? "Mine" : "Following"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading launches…
          </div>
        ) : error ? (
          <div className="mt-6 rounded-2xl border border-destructive/30 px-5 py-8 text-center text-sm">
            <p className="font-medium">Couldn&apos;t load launches.</p>
            <p className="mt-1 text-muted-foreground">
              Check the relay connection, then try again.
            </p>
            <Button
              className="mt-3"
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: [...launchesQueryKey],
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border/70 px-5 py-10 text-center text-sm text-muted-foreground">
            {filter === "all"
              ? "No launches yet. Founders: publish the first one."
              : "Nothing here. Follow a launch to pin it to this list."}
            {filter === "all" ? (
              <span className="mt-3 flex justify-center">
                <Button
                  onClick={() => setCreateOpen(true)}
                  size="sm"
                  type="button"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  New launch
                </Button>
              </span>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {visible.map((launch) => (
              <LaunchCard
                key={`${launch.record.author}:${launch.record.id}`}
                launch={launch}
                followed={followed.has(
                  launchFollowKey(launch.record.author, launch.record.id),
                )}
                onToggleFollow={() =>
                  toggle(
                    launchFollowKey(launch.record.author, launch.record.id),
                  )
                }
                onOpen={() =>
                  void goLaunch(launch.record.id, {
                    author: launch.record.author,
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>

      <CreateLaunchDialog
        isCreating={createMutation.isPending}
        onCreate={handleCreate}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-full bg-muted/70 px-2.5 py-1">
      <span className="text-sm font-semibold tabular-nums">{value}</span>
      <span className="text-2xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function LaunchCard({
  launch,
  followed,
  onToggleFollow,
  onOpen,
}: {
  launch: Launch;
  followed: boolean;
  onToggleFollow: () => void;
  onOpen: () => void;
}) {
  const stage = effectiveLaunchStage(launch);
  return (
    <li>
      <div className="flex h-full flex-col rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <div className="flex items-start gap-2">
          <button
            className="min-w-0 flex-1 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
            data-testid="launchpad-launch-card"
            onClick={onOpen}
            type="button"
          >
            <span className="block truncate text-sm font-semibold">
              {launch.record.name}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">
              {launch.record.pitch || "No pitch yet."}
            </span>
          </button>
          <button
            aria-label={followed ? "Unfollow launch" : "Follow launch"}
            aria-pressed={followed}
            onClick={onToggleFollow}
            className={cn(
              "rounded-lg p-1.5",
              followed
                ? "text-amber-500"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title={followed ? "Unfollow" : "Follow"}
            type="button"
          >
            <Star
              className="h-4 w-4"
              fill={followed ? "currentColor" : "none"}
            />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <LaunchStageBadge stage={stage} />
          <span className="text-2xs text-muted-foreground">
            {launch.record.admission === "community"
              ? "Community track"
              : "Curated track"}
          </span>
          <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
            {launch.updates.length} updates · {launch.bids.length} bids
          </span>
        </div>
        <div className="mt-2">
          <AuctionProgressBar record={launch.record} />
        </div>
      </div>
    </li>
  );
}
