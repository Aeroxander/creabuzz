import { BookMarked, Compass, Globe, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
  normalizeRelayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import {
  useCommunities,
  type CommunityDirectoryEntry,
} from "../use-communities";
import { Button } from "@/shared/ui/button";

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
          <p className="truncate text-xs text-black/60 dark:text-white/60">
            {entry.host}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-sm text-black/60 dark:text-white/60">
        {entry.description}
      </p>
      <p className="mt-auto flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60">
        <Users className="h-3.5 w-3.5" />
        {entry.member_count} member{entry.member_count === 1 ? "" : "s"}
        {entry.archived ? (
          <span
            className="ml-auto rounded-full bg-black/10 px-2 py-0.5 text-2xs font-medium uppercase dark:bg-white/15"
            data-testid={`community-archived-${entry.host}`}
          >
            Archived
          </span>
        ) : null}
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

function AddCommunityForm() {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const host = value.trim();
    if (!host) return;
    try {
      setStoredRelayWsUrl(normalizeRelayWsUrl(host));
      window.location.reload();
    } catch {
      toast.error("That doesn't look like a relay host");
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full max-w-sm items-center gap-2">
      <label className="sr-only" htmlFor="add-community">
        Relay host
      </label>
      <input
        id="add-community"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="relay.example.com"
        className="flex-1 rounded-md border border-black/10 bg-white px-3 py-1.5 text-sm text-black placeholder:text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
        data-testid="add-community-input"
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="dark:border-white/15"
        data-testid="add-community-submit"
      >
        <Globe /> Add community
      </Button>
    </form>
  );
}

export function CommunityDirectoryPage() {
  const { data, isLoading } = useCommunities();

  return (
    <div className="flex h-full w-full flex-1 flex-col gap-6 overflow-y-auto px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-black dark:text-white">
          <Compass className="h-5 w-5" /> Communities
        </h1>
        <AddCommunityForm />
        <Link to="/repos">
          <Button variant="outline" size="sm" className="dark:border-white/15">
            <BookMarked /> Repositories
          </Button>
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
            <Compass className="h-7 w-7 text-black/60 dark:text-white/60" />
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
