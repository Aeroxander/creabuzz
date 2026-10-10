/**
 * What a board thread about a DAO decision gets: a header with where the
 * decision stands, read from the chain, and, beside each person's name, how
 * much of the DAO's Shares they hold.
 *
 * Both rest on the same check. A post names a decision in its tags, and anyone
 * can write any tag, so nothing is read or shown for a DAO that no launch the
 * app knows has settled into (see `lib/dao-of-launch.ts`). For such a post the
 * header says it could not be checked, in plain words, and there are no
 * figures. Loaded only when a thread names a decision, so ordinary boards do
 * not carry the chain code.
 */

import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import type { BoardPost } from "@/features/board/lib/board-model";
import { Button } from "@/shared/ui/button";

import { useDaoThreads } from "@/features/board/use-dao-threads";
import { communityHostName } from "@/shared/lib/relay-url";
import { erc20BalanceOf, ethCall, getRpcEndpoint } from "../chain";
import { launchOfDao } from "../lib/dao-of-launch";
import { sharesBadge } from "../lib/shares-badge";
import type { Launch } from "../models";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { useLaunches } from "../use-launches";
import { usePeopleWithWallets } from "../use-people";
import { decisionStage } from "./DecisionCard";

const TOTAL_SUPPLY = "0x18160ddd";
/** At most this many people's holdings are read for one thread. */
const BADGE_LIMIT = 30;

function useShareBadges(
  shares: string | null,
  authors: readonly string[],
): Record<string, string> {
  const people = usePeopleWithWallets();
  const wallets = useMemo(
    () => new Map((people.data ?? []).map((p) => [p.pubkey, p.address])),
    [people.data],
  );
  const targets = useMemo(
    () => authors.filter((pubkey) => wallets.has(pubkey)).slice(0, BADGE_LIMIT),
    [authors, wallets],
  );
  const total = useQuery({
    queryKey: ["board", "shares-total", shares],
    enabled: shares !== null && targets.length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      BigInt(await ethCall(getRpcEndpoint(), shares as string, TOTAL_SUPPLY)),
  });
  const balances = useQueries({
    queries: targets.map((pubkey) => ({
      queryKey: ["board", "shares-balance", shares, wallets.get(pubkey)],
      enabled: shares !== null,
      staleTime: 60_000,
      queryFn: () =>
        erc20BalanceOf(
          getRpcEndpoint(),
          shares as string,
          wallets.get(pubkey) as string,
        ),
    })),
  });
  return useMemo(() => {
    const out: Record<string, string> = {};
    targets.forEach((pubkey, index) => {
      const label = sharesBadge(
        balances[index]?.data ?? null,
        total.data ?? null,
      );
      if (label) out[pubkey] = label;
    });
    return out;
  }, [targets, balances, total.data]);
}

function Header({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-3 rounded-xl border bg-secondary/30 p-3 text-sm"
      data-testid="proposal-header"
    >
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ScrollText aria-hidden className="h-3.5 w-3.5" />
        About a DAO decision
      </p>
      {children}
    </div>
  );
}

function launchTitle(launch: Launch): string {
  return launch.record.name || "this project";
}

export function ProposalExtras({
  post,
  authors,
  children,
}: {
  post: BoardPost;
  authors: readonly string[];
  children: (extras: {
    header: ReactNode;
    badges: Record<string, string>;
  }) => ReactNode;
}) {
  const ref = post.proposal;
  const launches = useLaunches();
  const launch = ref
    ? launchOfDao(launches.data ?? [], ref.chainId, ref.dao)
    : null;
  const dao = launch && ref ? ref.dao : null;
  const decisions = useDecisions(dao, null);
  const context = useDecisionContext(dao);
  const badges = useShareBadges(
    launch ? (context.data?.shares ?? null) : null,
    authors,
  );
  // The first thread started about a decision is its main discussion; this says whether the one open is it.
  const threads = useDaoThreads(launch && ref ? ref.chainId : null, dao ?? "");
  const mainThread = ref
    ? [...(threads.threads.get(ref.id) ?? [])].sort(
        (a, b) => a.createdAt - b.createdAt || (a.postId < b.postId ? -1 : 1),
      )[0]
    : undefined;

  if (!ref) return <>{children({ header: null, badges: {} })}</>;

  let body: ReactNode;
  if (launches.isLoading) {
    body = (
      <p className="mt-1 text-xs text-muted-foreground" role="status">
        Checking which DAO this is about…
      </p>
    );
  } else if (!launch) {
    body = (
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="proposal-unverified"
      >
        This post says it is about a DAO decision, but this app doesn't know
        that DAO, so nothing here has been checked.
      </p>
    );
  } else if (decisions.isLoading) {
    body = (
      <p className="mt-1 text-xs text-muted-foreground" role="status">
        Reading the decision…
      </p>
    );
  } else if (decisions.error || !decisions.data) {
    body = (
      <p
        className="mt-1 text-xs text-destructive"
        data-testid="proposal-unreadable"
        role="alert"
      >
        Couldn't read the decision from the chain just now.{" "}
        <button
          className="underline"
          onClick={() => void decisions.refetch()}
          type="button"
        >
          Try again
        </button>
      </p>
    );
  } else {
    const decision = decisions.data.decisions.find(
      (d) => d.id.toLowerCase() === ref.id,
    );
    if (!decision) {
      body = (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="proposal-missing"
        >
          That decision isn't in {launchTitle(launch)}'s DAO. It may be on the
          newest page not shown here, or the post may be mistaken.
        </p>
      );
    } else {
      const stage = decisionStage(decision, decisions.data.chainTime);
      body = (
        <>
          <p className="mt-1">
            <span className="font-semibold" data-testid="proposal-status">
              {stage.label}
            </span>{" "}
            <span className="text-muted-foreground">
              for {launchTitle(launch)}
            </span>
          </p>
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="proposal-next"
          >
            {stage.next}
          </p>
          {mainThread ? (
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="proposal-main-thread"
            >
              {mainThread.postId === post.id ? (
                "This is the main discussion of this decision."
              ) : (
                <>
                  The main discussion of this decision is{" "}
                  <Link
                    className="underline"
                    params={{ host: communityHostName() }}
                    search={{
                      channel: mainThread.boardId,
                      post: mainThread.postId,
                    }}
                    to="/c/$host"
                  >
                    {mainThread.title}
                  </Link>
                  .
                </>
              )}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button asChild size="sm" variant="outline">
              <Link
                data-testid="proposal-open-vote"
                params={{ launchId: launch.record.id }}
                search={{
                  author: launch.record.author,
                  tab: "decisions",
                  decision: ref.id,
                }}
                to="/launchpad/$launchId"
              >
                See the decision and vote
              </Link>
            </Button>
          </div>
        </>
      );
    }
  }

  const header = (
    <Header>
      {body}
      <p className="mt-2 text-xs text-muted-foreground">
        Votes on this board show what people think. They are not the DAO's vote,
        which happens on the decision itself.
      </p>
    </Header>
  );
  return <>{children({ header, badges })}</>;
}
