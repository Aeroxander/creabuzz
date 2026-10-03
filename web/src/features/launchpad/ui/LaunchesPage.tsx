import { useRef, useState } from "react";
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
import {
  closingSoonLaunches,
  graduatedLaunches,
} from "@/features/feed/lib/launch-filters";
import { useChainBlockHeight, useVoteTallies } from "@/features/feed/use-feed";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus, Rocket } from "lucide-react";
import { toast } from "sonner";
import { EMPTY_CHAT, ensureRooms } from "../use-launch-chat";

import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { LAUNCHPAD_EVENT_KINDS } from "@/shared/constants/kinds";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  useCreateLaunch,
  useLaunches,
  type CreateLaunchInput,
} from "../use-launches";
import { effectiveStage, type LaunchChat } from "../models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { useProfiles, resolveUserName } from "@/features/profiles/use-profiles";
import { LaunchCard } from "./LaunchCard";
import { StartIdeaDialog } from "./StartIdeaDialog";
import { isIdea } from "../lib/idea";
import { useSupporters } from "../use-supporters";
import { ProgressBar } from "./widgets";
import { cn } from "@/shared/lib/cn";

type Filter = "all" | "mine" | "following" | "closing-soon" | "graduated";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  mine: "Mine",
  following: "Following",
  "closing-soon": "Closing soon",
  graduated: "Graduated",
};
export function LaunchesPage() {
  const { data, isLoading, error, refetch } = useLaunches();
  const create = useCreateLaunch();
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [sort, setSort] = useState<SortMode>("hot");
  const follows = useLaunchFollows();
  const { tallies } = useVoteTallies();
  const pubkey = existingUserPubkey();

  const launches = data ?? [];
  const blockHeight = useChainBlockHeight();
  // "Closing soon" is chain-truth and sorts by soonest end; the other filters
  // keep the person's usual ranking.
  const filtered =
    filter === "closing-soon"
      ? closingSoonLaunches(launches, blockHeight)
      : filter === "graduated"
        ? graduatedLaunches(launches)
        : launches.filter((launch) => {
            if (filter === "mine") return launch.record.author === pubkey;
            if (filter === "following")
              return follows.followed.has(launchCoord(launch.record));
            return true;
          });
  const visible =
    filter === "closing-soon"
      ? filtered
      : sortByMode(
          filtered,
          sort,
          (launch) => tallies.get(launchCoord(launch.record))?.score ?? 0,
          (launch) => launch.record.createdAt,
        );

  const authors = [...new Set(visible.map((launch) => launch.record.author))];
  const { data: profiles } = useProfiles(authors);
  const supporters = useSupporters(
    visible.map((launch) => launchCoord(launch.record)),
  );

  const rooms = useRef<LaunchChat | null>(null);
  const handleCreate = async (input: CreateLaunchInput) => {
    try {
      // Rooms first, so the record never names a room that does not exist. A
      // room failure must not block the launch: the rest can be created from
      // the launch page. A retry after a failed publish reuses the rooms made.
      const ensured = await ensureRooms({
        launchName: input.name,
        chat: rooms.current ?? input.chat ?? EMPTY_CHAT,
        team: [],
        sale: true,
      });
      rooms.current = ensured.chat;
      if (ensured.incomplete) {
        toast.error(
          "Some chat rooms could not be created. You can add them from the launch page.",
        );
      }
      await create.mutateAsync({ ...input, chat: ensured.chat });
      rooms.current = null;
      toast.success("Launch published.");
      setCreateOpen(false);
    } catch {
      // The dialog stays open and renders the failure beside its publish
      // button — including the unlock action when the passkey is locked — so
      // the refusal is never a toast that disappears with no way forward.
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Rocket className="h-5 w-5" /> Launchpad
          </span>
        }
        description="Discover raises to back — or launch your own DAO."
        action={
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              variant="outline"
            >
              Set up a sale
            </Button>
            <Button
              data-testid="start-idea"
              onClick={() => setIdeaOpen(true)}
              size="sm"
            >
              <Plus className="mr-1 h-4 w-4" /> Start an idea
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2"
          role="tablist"
          aria-label="Launch filter"
        >
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              data-testid={`launch-filter-${f}`}
              onClick={() => setFilter(f)}
              className={cn(
                "border-b-[3px] px-1 pb-1.5 text-base font-semibold transition-colors",
                filter === f
                  ? "border-primary text-foreground"
                  : "border-transparent text-foreground/60 hover:text-foreground",
              )}
              type="button"
            >
              {FILTER_LABELS[f]}
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
              onClick={() => setIdeaOpen(true)}
              size="sm"
            >
              <Plus className="mr-1 h-4 w-4" /> Start an idea
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
          <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {visible.map((launch) => {
              const key = launchCoord(launch.record);
              const founder = profiles?.[launch.record.author];
              return (
                <li key={key}>
                  <LaunchCard
                    idea={isIdea(launch.record)}
                    supporters={supporters.data?.get(key) ?? null}
                    bids={launch.bids.length}
                    followDisabled={!follows.ready || follows.pending}
                    followed={follows.followed.has(key)}
                    footer={
                      <div className="space-y-2">
                        <ProgressBar quietWhenUnknown record={launch.record} />
                        <VoteButtons
                          label={launch.record.name}
                          launch={launchRef(launch.record)}
                          tally={tallies.get(key) ?? EMPTY_TALLY}
                          target={launchVoteTarget(launch.record)}
                          testId="launch-card-vote"
                        />
                      </div>
                    }
                    founder={
                      founder
                        ? {
                            name: resolveUserName(
                              founder,
                              launch.record.author,
                            ),
                            picture: founder.picture ?? null,
                          }
                        : undefined
                    }
                    onToggleFollow={() => follows.toggle(key)}
                    record={launch.record}
                    stage={effectiveStage(launch)}
                    updates={launch.updates.length}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}

      {ideaOpen ? <StartIdeaDialog onClose={() => setIdeaOpen(false)} /> : null}
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
