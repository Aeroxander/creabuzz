import { useState } from "react";
import { SANDBOX_ID } from "../lib/sandbox";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus, Rocket, Star } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import {
  useCreateLaunch,
  useLaunches,
  type CreateLaunchInput,
} from "../use-launches";
import { effectiveStage, type Launch } from "../models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { ProgressBar, StageBadge } from "./widgets";
import { cn } from "@/shared/lib/cn";

type Filter = "all" | "mine" | "following";
const FOLLOW_KEY = "buzz.launchpad.followed";

function readFollowed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FOLLOW_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function followKey(author: string, id: string): string {
  return `${author}:${id}`;
}

export function LaunchesPage() {
  const { data, isLoading, error, refetch } = useLaunches();
  const create = useCreateLaunch();
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [followed, setFollowed] = useState<Set<string>>(readFollowed);
  const pubkey = existingUserPubkey();

  const launches = data ?? [];
  const visible = launches.filter((launch) => {
    if (filter === "mine") return launch.record.author === pubkey;
    if (filter === "following")
      return followed.has(followKey(launch.record.author, launch.record.id));
    return true;
  });

  const toggleFollow = (launch: Launch) => {
    const key = followKey(launch.record.author, launch.record.id);
    setFollowed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(FOLLOW_KEY, JSON.stringify([...next]));
      } catch {
        // In-memory set still applies.
      }
      return next;
    });
  };

  const handleCreate = async (input: CreateLaunchInput) => {
    try {
      await create.mutateAsync(input);
      toast.success("Launch published.");
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Publishing failed.");
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
        <span className="ml-auto text-xs text-black/60 dark:text-white/60">
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
          message={errorMessage(error)}
          onRetry={() => void refetch()}
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
            search={{ author: undefined }}
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
              const key = followKey(launch.record.author, launch.record.id);
              const isFollowed = followed.has(key);
              return (
                <li key={key}>
                  <Card className="flex h-full flex-col p-4">
                    <div className="flex items-start gap-2">
                      <Link
                        to="/launchpad/$launchId"
                        params={{ launchId: launch.record.id }}
                        search={{ author: launch.record.author }}
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
                        onClick={() => toggleFollow(launch)}
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
        />
      ) : null}
    </div>
  );
}
