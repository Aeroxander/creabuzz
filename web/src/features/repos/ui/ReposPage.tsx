import { BookMarked, GitBranch, WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import buzzAppIcon from "@/assets/app-icon@3x.png";
import {
  normalizeRelayWsUrl,
  relayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useUserNames } from "@/features/profiles/use-profiles";
import { mockRepos } from "../mock-repos";
import { useRepos } from "../use-repos";
import { ConnectButton } from "./ConnectButton";
import { OrgSidebar } from "./OrgSidebar";
import { RepoListItem } from "./RepoListItem";

type SortOrder = "newest" | "oldest" | "name";

function ListItemSkeleton() {
  return (
    <div className="py-6">
      <div className="flex items-center gap-2">
        <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="h-5 w-48 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="h-5 w-14 animate-pulse rounded bg-black/10 dark:bg-white/10" />
      </div>
      <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-black/10 dark:bg-white/10" />
      <div className="mt-2 flex gap-4">
        <div className="h-3 w-24 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="h-3 w-20 animate-pulse rounded bg-black/10 dark:bg-white/10" />
      </div>
    </div>
  );
}

function SearchEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
        <GitBranch className="h-7 w-7 text-black/60 dark:text-white/60" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-black dark:text-white">
        No matching repositories
      </h2>
      <p className="mt-1 max-w-sm text-sm text-black/60 dark:text-white/60">
        Try adjusting your search term.
      </p>
    </div>
  );
}

function CommunityEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center bg-[#F3F3F3] px-4 py-16 text-center dark:bg-[#171717]">
      <div className="flex w-full max-w-xl flex-col items-center px-6 py-10 sm:px-12 sm:py-12">
        <div
          className="h-16 w-16 overflow-hidden bg-black"
          style={{ borderRadius: "22.37%" }}
        >
          <img alt="Creaton" className="h-full w-full" src={buzzAppIcon} />
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-black dark:text-white">
          This community is empty
        </h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-black/60 dark:text-white/60">
          Repositories pushed to this community will show up here. Open this
          community in the Buzz desktop app to start pushing code.
        </p>
        <ConnectButton className="mt-6" />
      </div>
    </div>
  );
}

function CommunityConnectionError({ message }: { message: string }) {
  const queryClient = useQueryClient();
  const currentRelay = relayWsUrl();
  const [relayInput, setRelayInput] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);

  const retry = () => {
    setConnectError(null);
    void queryClient.invalidateQueries({ queryKey: ["repos"] });
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!relayInput.trim()) {
      setConnectError("Enter a relay URL to connect to.");
      return;
    }
    try {
      const normalized = normalizeRelayWsUrl(relayInput);
      setStoredRelayWsUrl(normalized);
      window.location.reload();
    } catch {
      setConnectError("That doesn't look like a valid relay URL.");
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-[#F3F3F3] px-4 py-16 text-center dark:bg-[#171717]">
      <div className="flex w-full max-w-xl flex-col items-center px-6 py-10 sm:px-12 sm:py-12">
        <div
          className="h-16 w-16 overflow-hidden bg-black"
          style={{ borderRadius: "22.37%" }}
        >
          <img alt="Creaton" className="h-full w-full" src={buzzAppIcon} />
        </div>
        <div className="mt-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
          <WifiOff className="h-5 w-5 text-black/60 dark:text-white/60" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-black dark:text-white">
          Couldn't reach the relay
        </h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-black/60 dark:text-white/60">
          {message}
        </p>
        <p className="mt-4 max-w-md text-xs leading-relaxed text-black/60 dark:text-white/60">
          The web app is trying to reach{" "}
          <code className="rounded bg-black/10 px-1 py-0.5 dark:bg-white/10">
            {currentRelay}
          </code>
          . If that isn't your community's relay, enter its URL to connect.
        </p>
        <form
          onSubmit={connect}
          className="mt-4 flex w-full max-w-sm flex-col items-stretch gap-2"
        >
          <label className="sr-only" htmlFor="relay-url">
            Relay URL
          </label>
          <Input
            id="relay-url"
            type="text"
            placeholder="wss://relay.example.com"
            value={relayInput}
            onChange={(e) => setRelayInput(e.target.value)}
            className="border-black/10 bg-white text-black placeholder:text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
          />
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              Connect
            </Button>
            <button
              type="button"
              onClick={retry}
              className="flex-1 rounded-md border border-black/15 bg-white px-4 py-2 text-sm font-medium text-black shadow-xs hover:bg-black/5 dark:border-white/15 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
            >
              Try again
            </button>
          </div>
          {connectError && (
            <p className="text-xs text-destructive">{connectError}</p>
          )}
        </form>
      </div>
    </div>
  );
}

export function ReposPage() {
  const preview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("preview")
    : null;
  const showMockRepos = preview === "repositories";
  const showMockEmptyState = preview === "empty";
  const {
    data: fetchedRepos,
    isLoading: isLoadingRepos,
    error,
  } = useRepos({ enabled: !showMockRepos && !showMockEmptyState });
  const repos = showMockRepos
    ? mockRepos
    : showMockEmptyState
      ? []
      : fetchedRepos;
  const isLoading = preview ? false : isLoadingRepos;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOrder>("newest");

  // Every owner label in the list comes from one batched lookup; a hook per row
  // would be one profile query per repository.
  const ownerPubkeys = useMemo(
    () => [...new Set((repos ?? []).map((repo) => repo.owner))],
    [repos],
  );
  const ownerNames = useUserNames(ownerPubkeys);

  useEffect(() => {
    if (error) {
      toast.error("Failed to load repositories", {
        description: error.message,
      });
    }
  }, [error]);

  const filteredRepos = useMemo(() => {
    if (!repos) return [];

    const term = search.toLowerCase();
    let result = repos.filter(
      (r) =>
        r.name.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term),
    );

    switch (sort) {
      case "newest":
        result = result.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "oldest":
        result = result.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "name":
        result = result.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
        break;
    }

    return result;
  }, [repos, search, sort]);

  if (isLoading) {
    return (
      <div className="flex w-full flex-1 gap-8 bg-[#F3F3F3] px-4 py-8 dark:bg-[#171717]">
        <div className="min-w-0 flex-1">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-black dark:text-white">
            <BookMarked className="h-4 w-4" /> Repositories
          </h2>
          <div className="divide-y">
            {["a", "b", "c", "d", "e"].map((key) => (
              <ListItemSkeleton key={key} />
            ))}
          </div>
        </div>
        <aside className="hidden w-72 shrink-0 lg:block" />
      </div>
    );
  }

  if (error) {
    return <CommunityConnectionError message={error.message} />;
  }

  if (!repos || repos.length === 0) {
    return <CommunityEmptyState />;
  }

  return (
    <div className="flex w-full flex-1 gap-8 bg-[#F3F3F3] px-4 py-8 dark:bg-[#171717]">
      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Mobile-only connect button */}
        <div className="mb-4 lg:hidden">
          <ConnectButton className="w-full" />
        </div>

        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-black dark:text-white">
          <BookMarked className="h-4 w-4" /> Repositories
        </h2>

        {/* Search + Sort bar */}
        <div className="mb-4 flex gap-3">
          <Input
            placeholder="Find a repository..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 border-black/10 bg-white text-black placeholder:text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOrder)}
            aria-label="Sort repositories"
            className="rounded-md border border-black/10 bg-white px-3 py-1 text-sm text-black shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-black dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus-visible:ring-white"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Repo list */}
        {filteredRepos.length > 0 ? (
          <div className="divide-y divide-black/10 dark:divide-white/10">
            {filteredRepos.map((repo) => (
              <RepoListItem
                key={repo.id}
                repo={repo}
                ownerName={ownerNames(repo.owner)}
                preview={showMockRepos}
              />
            ))}
          </div>
        ) : (
          <SearchEmptyState />
        )}
      </div>

      {/* Sidebar */}
      <aside className="hidden w-72 shrink-0 border-l border-black/10 pl-8 dark:border-white/10 lg:block">
        <OrgSidebar repos={repos} />
      </aside>
    </div>
  );
}
