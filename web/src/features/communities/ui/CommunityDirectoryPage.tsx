import { BookMarked, Compass, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";

import {
  useCommunities,
  type CommunityDirectoryEntry,
} from "../use-communities";

function CommunityCard({ entry }: { entry: CommunityDirectoryEntry }) {
  const hostName = entry.name || entry.host;
  return (
    <Link
      to="/c/$host"
      params={{ host: entry.host }}
      className="group flex flex-col gap-3 rounded-lg border border-black/10 bg-white p-5 shadow-xs transition-colors hover:border-black/25 hover:bg-black/[0.02] dark:border-white/10 dark:bg-white/5 dark:hover:border-white/25"
    >
      <div className="flex items-center gap-3">
        {entry.icon ? (
          <img
            alt=""
            src={entry.icon}
            className="h-10 w-10 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-black/5 text-lg font-semibold text-black/60 dark:bg-white/10 dark:text-white/70">
            {hostName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-black dark:text-white">
            {hostName}
          </h3>
          <p className="truncate text-xs text-black/50 dark:text-white/50">
            {entry.host}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-sm text-black/60 dark:text-white/60">
        {entry.description}
      </p>
      <p className="mt-auto flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
        <Users className="h-3.5 w-3.5" />
        {entry.member_count} member{entry.member_count === 1 ? "" : "s"}
      </p>
    </Link>
  );
}

function CardSkeleton() {
  return (
    <div className="flex h-44 animate-pulse flex-col gap-3 rounded-lg border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-black/10 dark:bg-white/10" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 rounded bg-black/10 dark:bg-white/10" />
          <div className="h-3 w-1/2 rounded bg-black/10 dark:bg-white/10" />
        </div>
      </div>
      <div className="h-3 w-full rounded bg-black/10 dark:bg-white/10" />
      <div className="h-3 w-4/5 rounded bg-black/10 dark:bg-white/10" />
    </div>
  );
}

export function CommunityDirectoryPage() {
  const { data, isLoading } = useCommunities();

  return (
    <div className="flex w-full flex-1 flex-col gap-6 bg-[#F3F3F3] px-4 py-8 dark:bg-[#171717]">
      <header className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-black dark:text-white">
          <Compass className="h-5 w-5" /> Communities
        </h1>
        <Link
          to="/repos"
          className="flex items-center gap-1.5 rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium text-black hover:bg-black/5 dark:border-white/15 dark:text-white dark:hover:bg-white/10"
        >
          <BookMarked className="h-4 w-4" /> Repositories
        </Link>
      </header>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {["a", "b", "c", "d", "e", "f"].map((key) => (
            <CardSkeleton key={key} />
          ))}
        </div>
      ) : data && data.communities.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
            <Compass className="h-7 w-7 text-black/50 dark:text-white/50" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-black dark:text-white">
            No communities on this relay yet
          </h2>
          <p className="mt-1 max-w-sm text-sm text-black/60 dark:text-white/60">
            Communities hosted by this relay will show up here, browsable
            without an account.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.communities.map((entry) => (
            <CommunityCard key={entry.host} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
