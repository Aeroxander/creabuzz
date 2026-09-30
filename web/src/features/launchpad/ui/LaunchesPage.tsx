import { useState } from "react";
import { SANDBOX_ID } from "../lib/sandbox";
import {
  launchCoord,
  launchRef,
  launchVoteTarget,
} from "@/features/feed/ui/LaunchVoteCard";
import { VoteButtons } from "@/features/feed/ui/VoteButtons";
import {
  EMPTY_TALLY,
  type SortMode,
  sortByMode,
} from "@/features/feed/lib/ranking";
import { useVoteTallies } from "@/features/feed/use-feed";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus, Rocket, Star } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { LAUNCHPAD_EVENT_KINDS } from "@/shared/constants/kinds";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  useCreateLaunch,
  useLaunches,
  type CreateLaunchInput,
} from "../use-launches";
import { effectiveStage } from "../models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { ProgressBar, StageBadge } from "./widgets";
import { cn } from "@/shared/lib/cn";

type Filter = "all" | "mine" | "following";
export function LaunchesPage() {
  const { data, isLoading, error, refetch } = useLaunches();
  const create = useCreateLaunch();
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [sort, setSort] = useState<SortMode>("hot");
  const follows = useLaunchFollows();
  const { tallies } = useVoteTallies();
  const pubkey = existingUserPubkey();

  const launches = data ?? [];
  const filtered = launches.filter((launch) => {
    if (filter === "mine") return launch.record.author === pubkey;
    if (filter === "following")
      return follows.followed.has(launchCoord(launch.record));
    return true;
  });
  const visible = sortByMode(
    filtered,
    sort,
    (launch) => tallies.get(launchCoord(launch.record))?.score ?? 0,
    (launch) => launch.record.createdAt,
  );

  const handleCreate = async (input: CreateLaunchInput) => {
    try {
      await create.mutateAsync(input);
      toast.success("Launch published.");
      setCreateOpen(false);
    } catch {
      // The dialog stays open and renders the failure beside its publish
      // button — including the unlock action when the passkey is locked — so
      // the refusal is never a toast that disappears with no way forward.
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Rocket className="h-5 w-5" /> Launchpad
          </span>
        }
        description="Discover raises to back — or launch your own DAO."
        action={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="mr-1 h-4 w-4" /> New launch
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap items-center gap-2"
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
                "rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide",
                filter === f
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
              )}
              type="button"
            >
              {f === "all" ? "All" : f === "mine" ? "Mine" : "Following"}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <label className="sr-only" htmlFor="launch-sort">
            Sort launches
          </label>
          <select
            className="rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs dark:border-white/15"
            data-testid="launch-sort"
            id="launch-sort"
            onChange={(e) => setSort(e.target.value as SortMode)}
            value={sort}
          >
            <option value="hot">Hot</option>
            <option value="new">New</option>
            <option value="top">Top</option>
          </select>
          {launches.length} launches
        </span>
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-black/60 dark:text-white/60">
          Loading launches…
        </p>
      ) : error ? (
        <QueryError
          description="The relay did not answer the launch query, so nothing can be listed."
          error={error}
          kinds={LAUNCHPAD_EVENT_KINDS}
          message={errorMessage(error)}
          onRetry={() => void refetch()}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="launchpad-load-error"
          title="Couldn't load the launchpad"
        />
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 px-5 py-12 text-center dark:border-white/15">
          <p className="text-sm text-black/60 dark:text-white/60">
            {filter === "all"
              ? "No launches yet. Founders: publish the first one."
              : "Nothing here. Follow a launch to pin it to this list."}
          </p>
          {filter === "all" ? (
            <Button
              className="mt-4"
              onClick={() => setCreateOpen(true)}
              size="sm"
            >
              <Plus className="mr-1 h-4 w-4" /> New launch
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <Link
            className="mb-4 flex items-center justify-between rounded-2xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 transition-colors hover:bg-violet-500/10"
            to="/launchpad/$launchId"
            params={{ launchId: SANDBOX_ID }}
            search={{ action: undefined, author: undefined }}
            data-testid="sandbox-entry"
          >
            <span>
              <span className="block text-sm font-semibold">
                Try the sandbox
              </span>
              <span className="block text-xs text-black/60 dark:text-white/60">
                A full simulated raise, end to end — no chain, no real money.
              </span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0" />
          </Link>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {visible.map((launch) => {
              const key = launchCoord(launch.record);
              const isFollowed = follows.followed.has(key);
              return (
                <li key={key}>
                  <Card className="flex h-full flex-col p-4">
                    <div className="flex items-start gap-2">
                      <Link
                        to="/launchpad/$launchId"
                        params={{ launchId: launch.record.id }}
                        search={{
                          action: undefined,
                          author: launch.record.author,
                        }}
                        className="min-w-0 flex-1"
                      >
                        <span className="block truncate text-base font-semibold hover:underline">
                          {launch.record.name}
                        </span>
                        {launch.record.agent ? (
                          <span
                            className="ml-1 inline-block rounded-full bg-violet-500/15 px-1.5 py-0.5 align-middle text-2xs font-medium text-violet-700 dark:text-violet-300"
                            data-testid="launch-agent-badge"
                            title={`Run by agent ${launch.record.agent.slice(0, 8)}…`}
                          >
                            Agent-run
                          </span>
                        ) : null}
                        <span className="mt-0.5 line-clamp-2 block text-sm text-black/60 dark:text-white/60">
                          {launch.record.pitch || "No pitch yet."}
                        </span>
                      </Link>
                      <button
                        aria-label={
                          isFollowed ? "Unfollow launch" : "Follow launch"
                        }
                        aria-pressed={isFollowed}
                        disabled={!follows.ready || follows.pending}
                        onClick={() => follows.toggle(key)}
                        className={cn(
                          "rounded-lg p-1.5",
                          isFollowed
                            ? "text-amber-500"
                            : "text-black/60 hover:bg-black/5 dark:text-white/60",
                        )}
                        type="button"
                      >
                        <Star
                          className="h-4 w-4"
                          fill={isFollowed ? "currentColor" : "none"}
                        />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <VoteButtons
                        label={launch.record.name}
                        launch={launchRef(launch.record)}
                        tally={tallies.get(key) ?? EMPTY_TALLY}
                        target={launchVoteTarget(launch.record)}
                        testId="launch-card-vote"
                      />
                      <StageBadge stage={effectiveStage(launch)} />
                      <span className="text-xs text-black/60 dark:text-white/60">
                        {launch.updates.length} updates · {launch.bids.length}{" "}
                        bids
                      </span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar record={launch.record} />
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {createOpen ? (
        <CreateLaunchDialog
          isCreating={create.isPending}
          onCreate={handleCreate}
          onClose={() => setCreateOpen(false)}
          publishError={create.isError ? errorMessage(create.error) : null}
        />
      ) : null}
    </div>
  );
}
