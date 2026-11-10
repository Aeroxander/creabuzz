import { useEffect, useRef, useState } from "react";
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
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Lightbulb, Plus, Rocket } from "lucide-react";
import { toast } from "sonner";
import { EMPTY_CHAT, ensureRooms, setupNotice } from "../use-launch-chat";

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
import { effectiveStage, type LaunchChat, type Launch } from "../models";
import {
  FUNDING_SEEKING,
  FUNDING_SEEKING_LABELS,
  FUNDING_STANCES,
  FUNDING_STANCE_LABELS,
  effectiveFunding,
  fundingCounts,
  matchesFunding,
  raisingFirst,
  type FundingSeeking,
  type FundingStance,
  type ResolvedFunding,
} from "../lib/funding";
import { existingUserPubkey } from "@/shared/lib/identity";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { useProfiles, resolveUserName } from "@/features/profiles/use-profiles";
import { CheckQuietNote } from "./CheckNoteCard";
import { LaunchCard } from "./LaunchCard";
import { StartIdeaDialog } from "./StartIdeaDialog";
import { isContributorProject } from "../lib/funding";
import { isIdea } from "../lib/idea";
import { listedHere } from "../lib/contributor-only";
import { notListedYet } from "../lib/listing";
import { raisesOffered } from "../lib/raises-offered";
import { useSupporters } from "../use-supporters";
import { ProgressBar } from "./widgets";
import { cn } from "@/shared/lib/cn";
import { countOf } from "@/shared/lib/count-of";

type Filter =
  | "all"
  | "ideas"
  | "mine"
  | "following"
  | "closing-soon"
  | "graduated";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  ideas: "Ideas",
  mine: "Mine",
  following: "Following",
  "closing-soon": "Closing soon",
  graduated: "Sale completed",
};
/** The tabs that are about sales, left out where the build offers none. */
const SALE_FILTERS: ReadonlySet<Filter> = new Set([
  "closing-soon",
  "graduated",
]);
/**
 * One funding chip: the label, the count it would show, and whether it is the
 * row's current choice. A `<button>` with its own text and `aria-pressed`, so
 * there is exactly one screen-reader stop and one name for it.
 */
function FundingChip({
  label,
  count,
  active,
  onClick,
  testId,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary-ink"
          : "border-black/10 text-black/60 hover:border-black/25 hover:text-black dark:border-white/15 dark:text-white/60 dark:hover:text-white",
      )}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      {label}{" "}
      <span className="tabular-nums opacity-60" data-testid={`${testId}-count`}>
        {count}
      </span>
    </button>
  );
}

export function LaunchesPage() {
  const { data, isLoading, error, refetch } = useLaunches();
  const create = useCreateLaunch();
  // The contributor-only hosted image cannot launch a sale, so it offers none: no Set up a sale, no Markets, no raise
  // sandbox, no sale tabs or funding chips, and `?start=sale` opens nothing. It lists contributor projects and ideas only;
  // a raise another build published stays readable by its own link.
  const raises = raisesOffered();
  // Without raises this page is the list of ideas (projects are on Discover): it opens on them.
  const [filter, setFilter] = useState<Filter>(raises ? "all" : "ideas");
  // The Start page links here with `?start=idea` or `?start=sale`: open that dialog once, then drop the parameter so a
  // reload does not open it again.
  const { start } = useSearch({ from: "/launchpad" });
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(start === "sale" && raises);
  const [ideaOpen, setIdeaOpen] = useState(start === "idea");
  useEffect(() => {
    if (start) void navigate({ to: "/launchpad", search: {}, replace: true });
  }, [start, navigate]);
  const [sort, setSort] = useState<SortMode>("hot");
  /** The funding chips; null is the chip row's own "everything" chip. */
  const [stanceFilter, setStanceFilter] = useState<FundingStance | null>(null);
  const [seekingFilter, setSeekingFilter] = useState<FundingSeeking | null>(
    null,
  );
  const follows = useLaunchFollows();
  const { tallies } = useVoteTallies();
  const pubkey = existingUserPubkey();

  // A project its founder marked "Not listed yet" is in nobody's list but their own.
  const launches = (data ?? []).filter(
    (launch) =>
      listedHere(launch.record, raises) &&
      (launch.record.author === pubkey || !notListedYet(launch.record)),
  );
  const blockHeight = useChainBlockHeight();
  const fundingOf = (launch: Launch): ResolvedFunding =>
    effectiveFunding(launch, blockHeight);
  // "Closing soon" is chain-truth and sorts by soonest end; the other filters
  // keep the person's usual ranking.
  const filtered =
    filter === "closing-soon"
      ? closingSoonLaunches(launches, blockHeight)
      : filter === "graduated"
        ? graduatedLaunches(launches)
        : launches.filter((launch) => {
            if (filter === "ideas") return isIdea(launch.record);
            if (filter === "mine") return launch.record.author === pubkey;
            if (filter === "following")
              return follows.followed.has(launchCoord(launch.record));
            return true;
          });
  // The chips count the whole tab, so choosing one never empties the row.
  const counts = fundingCounts(filtered.map(fundingOf));
  const facing = filtered.filter((launch) =>
    matchesFunding(fundingOf(launch), {
      stance: stanceFilter ?? undefined,
      seeking: seekingFilter ?? undefined,
    }),
  );
  const ranked =
    filter === "closing-soon"
      ? facing
      : sortByMode(
          facing,
          sort,
          (launch) => tallies.get(launchCoord(launch.record))?.score ?? 0,
          (launch) => launch.record.createdAt,
        );
  // "Raising now" leads by default: on the usual ranking, live raises come
  // first and that same ranking still orders each group inside it.
  const visible = sort === "hot" ? raisingFirst(ranked, fundingOf) : ranked;

  const authors = [...new Set(visible.map((launch) => launch.record.author))];
  const { data: profiles } = useProfiles(authors);
  const supporters = useSupporters(
    visible.map((launch) => launchCoord(launch.record)),
  );

  const rooms = useRef<LaunchChat | null>(null);
  /** The name the rooms were made for; a renamed retry must make new rooms. */
  const roomsName = useRef<string | null>(null);
  const handleCreate = async (input: CreateLaunchInput) => {
    try {
      // Rooms first, so the record never names a room that does not exist. A
      // room failure must not block the launch: the rest can be created from
      // the launch page. A retry after a failed publish reuses the rooms made,
      // but only while the name is unchanged — rooms are named for the launch.
      if (roomsName.current !== input.name) {
        rooms.current = null;
        roomsName.current = input.name;
      }
      const ensured = await ensureRooms({
        launchName: input.name,
        chat: rooms.current ?? input.chat ?? EMPTY_CHAT,
        team: [],
        sale: true,
      });
      rooms.current = ensured.chat;
      const notice = setupNotice(ensured);
      if (notice) toast.error(notice);
      await create.mutateAsync({ ...input, chat: ensured.chat });
      rooms.current = null;
      roomsName.current = null;
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
          raises ? (
            <span className="flex items-center gap-2">
              <Rocket aria-hidden className="h-5 w-5" /> Launchpad
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Lightbulb aria-hidden className="h-5 w-5" /> Ideas
            </span>
          )
        }
        description={
          raises ? (
            "Find a raise to back, or start one of your own."
          ) : (
            <>
              Ideas people shared before starting a project. Projects are on{" "}
              <Link className="underline" to="/discover">
                Discover
              </Link>
              .
            </>
          )
        }
        action={
          <div className="flex items-center gap-2">
            {raises ? (
              <Button
                onClick={() => setCreateOpen(true)}
                size="sm"
                title="Skip the idea stage and set up a sale with your own terms"
                variant="ghost"
              >
                Set up a sale
              </Button>
            ) : null}
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
          aria-label={raises ? "Launch filter" : "Idea filter"}
        >
          {(Object.keys(FILTER_LABELS) as Filter[])
            .filter((f) => raises || !SALE_FILTERS.has(f))
            .map((f) => (
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
            {raises ? "Sort launches" : "Sort ideas"}
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
          {raises
            ? countOf(launches.length, "launch", "launches")
            : `${countOf(launches.filter((l) => isIdea(l.record)).length, "idea")} · ${countOf(launches.filter((l) => !isIdea(l.record)).length, "project")}`}
        </span>
      </div>

      {/* Filters only mean something once there is a list to filter: on an empty tab every chip would read zero. A
          contributor-only build lists no raise, so its cards have no funding to filter by. */}
      {raises ? (
        <div
          className={cn(
            "flex flex-col gap-2",
            filtered.length === 0 && "hidden",
          )}
          data-testid="launch-chips"
        >
          <fieldset className="min-w-0 border-0 p-0">
            <legend className="text-2xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              Funding
            </legend>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <FundingChip
                active={stanceFilter === null}
                count={filtered.length}
                label="Any"
                onClick={() => setStanceFilter(null)}
                testId="funding-chip-any"
              />
              {FUNDING_STANCES.map((stance) => (
                <FundingChip
                  active={stanceFilter === stance}
                  count={counts.stance[stance]}
                  key={stance}
                  label={FUNDING_STANCE_LABELS[stance]}
                  onClick={() =>
                    setStanceFilter(stanceFilter === stance ? null : stance)
                  }
                  testId={`funding-chip-${stance}`}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="min-w-0 border-0 p-0">
            <legend className="text-2xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              Looking for
            </legend>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <FundingChip
                active={seekingFilter === null}
                count={filtered.length}
                label="Anyone"
                onClick={() => setSeekingFilter(null)}
                testId="seeking-chip-any"
              />
              {FUNDING_SEEKING.map((wanted) => (
                <FundingChip
                  active={seekingFilter === wanted}
                  count={counts.seeking[wanted]}
                  key={wanted}
                  label={FUNDING_SEEKING_LABELS[wanted]}
                  onClick={() =>
                    setSeekingFilter(seekingFilter === wanted ? null : wanted)
                  }
                  testId={`seeking-chip-${wanted}`}
                />
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}

      {raises && !isLoading && !error ? (
        <Link
          className="mb-4 flex items-center justify-between rounded-2xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 transition-colors hover:bg-violet-500/10"
          to="/launchpad/$launchId"
          params={{ launchId: SANDBOX_ID }}
          search={{ action: undefined, author: undefined }}
          data-testid="sandbox-entry"
        >
          <span>
            <span className="block text-sm font-semibold">Try the sandbox</span>
            <span className="block text-xs text-black/60 dark:text-white/60">
              Walk through a full raise, start to finish. It is only practice:
              no real money is used.
            </span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" />
        </Link>
      ) : null}

      {isLoading ? (
        <p className="py-8 text-center text-sm text-black/60 dark:text-white/60">
          {raises ? "Loading launches…" : "Loading ideas…"}
        </p>
      ) : error ? (
        <QueryError
          description="The server didn't respond, so the list can't load."
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
          title={
            raises ? "Couldn't load the launchpad" : "Couldn't load the ideas"
          }
        />
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 px-5 py-12 text-center dark:border-white/15">
          <p className="text-sm text-black/60 dark:text-white/60">
            {stanceFilter !== null || seekingFilter !== null
              ? "Nothing matches those filters. Try removing one."
              : filter === "all"
                ? raises
                  ? "No launches yet. Start an idea to get going."
                  : "No projects yet. Start an idea to get going."
                : filter === "ideas"
                  ? "No ideas yet. Be the first to start one."
                  : filter === "mine"
                    ? "You haven't launched anything yet."
                    : filter === "closing-soon"
                      ? "Nothing is closing soon."
                      : filter === "graduated"
                        ? "No sales have completed yet."
                        : "Nothing here yet. Follow a launch to see it in this list."}
          </p>
          {stanceFilter === null &&
          seekingFilter === null &&
          (filter === "all" || filter === "ideas" || filter === "mine") ? (
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
        <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((launch) => {
            const key = launchCoord(launch.record);
            const founder = profiles?.[launch.record.author];
            return (
              <li key={key}>
                <LaunchCard
                  idea={isIdea(launch.record)}
                  funding={fundingOf(launch)}
                  supporters={supporters.data?.get(key) ?? null}
                  bids={launch.bids.length}
                  followDisabled={!follows.ready || follows.pending}
                  followed={follows.followed.has(key)}
                  footer={
                    <div className="space-y-2">
                      <ProgressBar quietWhenUnknown record={launch.record} />
                      {isContributorProject(launch.record) ? (
                        <CheckQuietNote launch={launch} />
                      ) : null}
                      {/* A contributor project here is one to open, as on Discover. */}
                      {!raises && isContributorProject(launch.record) ? (
                        <Button
                          asChild
                          className="w-full"
                          size="sm"
                          variant="outline"
                        >
                          <Link
                            data-testid="launch-card-open-project"
                            params={{ launchId: launch.record.id }}
                            search={{
                              action: undefined,
                              author: launch.record.author,
                            }}
                            to="/launchpad/$launchId"
                          >
                            Open project
                            <ArrowRight
                              aria-hidden
                              className="ml-1 h-3.5 w-3.5"
                            />
                          </Link>
                        </Button>
                      ) : null}
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
                          name: resolveUserName(founder, launch.record.author),
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
      )}

      {ideaOpen ? <StartIdeaDialog onClose={() => setIdeaOpen(false)} /> : null}
      {createOpen && raises ? (
        <CreateLaunchDialog
          isCreating={create.isPending}
          onCreate={handleCreate}
          onClose={() => {
            // An abandoned attempt must not lend its rooms to a later launch.
            rooms.current = null;
            roomsName.current = null;
            setCreateOpen(false);
          }}
          publishError={create.isError ? errorMessage(create.error) : null}
        />
      ) : null}
    </div>
  );
}
