import { BookMarked, Compass, Globe, Plus, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  communityHostName,
  relayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import {
  useCommunities,
  type CommunityDirectoryEntry,
} from "../use-communities";
import { Button } from "@/shared/ui/button";
import { ServerImage } from "@/shared/ui/ServerImage";
import { QueryError } from "@/shared/ui/query-error";
import { useSelfServe } from "../use-self-serve";
import { CreateCommunityDialog } from "./CreateCommunityDialog";
import { communityLabel, listedCommunities } from "../lib/community-label";
import {
  checkServer,
  parseServerAddress,
  saveServerAddress,
} from "../lib/server-switch";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { APP_NAME } from "@/shared/constants/brand";
import { existingUserPubkey } from "@/shared/lib/identity";

type CardEntry = Omit<CommunityDirectoryEntry, "member_count"> & {
  member_count: number | null;
};

function CommunityCard({
  entry,
  domain,
}: {
  entry: CardEntry;
  /** Where this server makes new communities, to name the ones made there. */
  domain: string | null;
}) {
  // The server's own name for it when it sends one; otherwise the name it was started under (see `communityLabel`).
  const label = entry.name
    ? {
        name: entry.name,
        address: entry.name === entry.host ? null : entry.host,
      }
    : communityLabel(entry.host, domain, APP_NAME);
  const hostName = label.name;
  return (
    <Link
      to="/c/$host"
      params={{ host: entry.host }}
      className="group flex flex-col gap-3 rounded-lg border border-black/10 bg-white p-5 shadow-xs transition-colors hover:border-black/25 hover:bg-black/[0.02] dark:border-white/10 dark:bg-white/5 dark:hover:border-white/25"
    >
      <div className="flex items-center gap-3">
        {entry.icon ? (
          <ServerImage
            alt=""
            src={entry.icon}
            className="h-10 w-10 rounded-lg object-cover"
            unavailable="icon"
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
          {label.address ? (
            <p className="truncate text-xs text-black/60 dark:text-white/60">
              {label.address}
            </p>
          ) : null}
        </div>
      </div>
      {entry.description ? (
        <p className="line-clamp-2 text-sm text-black/60 dark:text-white/60">
          {entry.description}
        </p>
      ) : null}
      <p className="mt-auto flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60">
        {entry.member_count !== null ? (
          <>
            <Users aria-hidden className="h-3.5 w-3.5" />
            {entry.member_count} member{entry.member_count === 1 ? "" : "s"}
          </>
        ) : (
          "Open community"
        )}
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

type AddState =
  | { step: "idle" }
  | { step: "checking"; host: string }
  | { step: "confirm"; wsUrl: string; host: string }
  | { step: "problem"; problem: string };

/**
 * Open a community on another server: the address is read, the server must answer, and the person confirms before
 * the address is saved and the page reloads onto it. A typo or a dead server never gets saved, and until the confirm
 * nothing has changed, so Cancel (or editing the address) is the way back.
 */
function AddCommunityForm() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<AddState>({ step: "idle" });
  // A check still running when the address changes, is cancelled or the page is left must not land afterwards: it is
  // stopped (its connection hung up) and its answer dropped.
  const generation = useRef(0);
  const running = useRef<AbortController | null>(null);
  const current = communityHostName();

  const stopCheck = () => {
    generation.current += 1;
    running.current?.abort();
    running.current = null;
  };
  useEffect(
    () => () => {
      generation.current += 1;
      running.current?.abort();
    },
    [],
  );

  const reset = (next: AddState = { step: "idle" }) => {
    stopCheck();
    setState(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseServerAddress(value);
    if (!parsed.ok) {
      reset({ step: "problem", problem: parsed.problem });
      return;
    }
    if (parsed.host === current) {
      reset({
        step: "problem",
        problem: "You are already on that server.",
      });
      return;
    }
    stopCheck();
    const mine = generation.current;
    const controller = new AbortController();
    running.current = controller;
    setState({ step: "checking", host: parsed.host });
    const check = await checkServer(parsed.wsUrl, {
      signal: controller.signal,
    });
    if (generation.current !== mine) return;
    running.current = null;
    setState(
      check.ok
        ? { step: "confirm", wsUrl: parsed.wsUrl, host: parsed.host }
        : { step: "problem", problem: check.problem },
    );
  };

  const open = (wsUrl: string) => {
    const problem = saveServerAddress(wsUrl, setStoredRelayWsUrl);
    if (problem) {
      reset({ step: "problem", problem });
      return;
    }
    window.location.reload();
  };

  return (
    <div className="mt-2 flex w-full max-w-md flex-col gap-2">
      <form
        onSubmit={(e) => void submit(e)}
        className="flex items-center gap-2"
      >
        <label className="sr-only" htmlFor="add-community">
          Server address
        </label>
        <input
          aria-describedby="add-community-status"
          aria-invalid={state.step === "problem"}
          id="add-community"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (state.step !== "idle") reset();
          }}
          placeholder="e.g. community.example.com"
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-1.5 text-sm text-black placeholder:text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
          data-testid="add-community-input"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="dark:border-white/15"
          data-testid="add-community-submit"
          disabled={state.step === "checking"}
        >
          <Globe /> Add community
        </Button>
      </form>
      <div aria-live="polite" id="add-community-status" role="status">
        {state.step === "checking" ? (
          <p className="text-xs text-black/60 dark:text-white/60">
            Checking {state.host}…
          </p>
        ) : state.step === "problem" ? (
          <p
            className="text-xs text-red-700 dark:text-red-300"
            data-testid="add-community-problem"
          >
            {state.problem}
          </p>
        ) : state.step === "confirm" ? (
          <p data-testid="add-community-confirm-text">
            {state.host} answered. Open it in this browser? You'll leave{" "}
            {current || "this server"}; to come back, add its address here
            again.
          </p>
        ) : null}
      </div>
      {state.step === "confirm" ? (
        <div className="flex gap-2" data-testid="add-community-confirm">
          <Button
            data-testid="add-community-open"
            onClick={() => open(state.wsUrl)}
            size="sm"
            type="button"
          >
            Open {state.host}
          </Button>
          <Button
            data-testid="add-community-cancel"
            onClick={() => reset()}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function CommunityDirectoryPage() {
  const { data, isLoading, isError, error, refetch } = useCommunities();
  const selfServe = useSelfServe();
  const [createOpen, setCreateOpen] = useState(false);
  const host = new URL(relayWsUrl()).host;
  const connected = data?.communities.find((entry) => entry.host === host);
  const otherCommunities = data
    ? listedCommunities(data.communities, host)
    : undefined;
  const domain = selfServe.data?.domain ?? null;
  const signedIn = existingUserPubkey() !== null;

  return (
    <div className="flex h-full w-full flex-1 flex-col gap-6 overflow-y-auto px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-black dark:text-white">
          <Compass className="h-5 w-5" /> Communities
        </h1>
        {selfServe.data?.enabled ? (
          <Button
            data-testid="create-community"
            onClick={() => setCreateOpen(true)}
            size="sm"
          >
            <Plus /> Create a community
          </Button>
        ) : null}
        {/* The hosted pilot is people and projects; code browsing is for the builds that offer it. */}
        {raisesOffered() ? (
          <Link to="/repos">
            <Button
              variant="outline"
              size="sm"
              className="dark:border-white/15"
            >
              <BookMarked /> Repositories
            </Button>
          </Link>
        ) : null}
      </header>
      {/* Pointing this browser at another server is rare and only matters to someone with an account. */}
      {signedIn ? (
        <details className="text-sm" data-testid="add-community-advanced">
          <summary className="cursor-pointer font-medium text-black/70 select-none dark:text-white/70">
            Advanced: open a community on another server
          </summary>
          <AddCommunityForm />
        </details>
      ) : null}

      <section aria-labelledby="connected-community-heading">
        <h2
          id="connected-community-heading"
          className="mb-3 text-sm font-semibold"
        >
          This community
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CommunityCard
            domain={domain}
            entry={
              connected ?? {
                host,
                name: "",
                description: "Rooms, boards and messages on this server.",
                member_count: null,
                archived: false,
              }
            }
          />
        </div>
      </section>

      {isError ? (
        <QueryError
          title="Couldn't load the list of communities"
          description="You can still open your community above. Try again to see the others."
          error={error}
          onRetry={() => void refetch()}
          testId="community-directory-error"
        />
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {["a", "b", "c", "d", "e", "f"].map((key) => (
            <CardSkeleton key={key} />
          ))}
        </div>
      ) : data?.available === false ? (
        <p className="text-sm text-black/60 dark:text-white/60">
          This server doesn't list its communities. Open your community above to
          reach its rooms.
        </p>
      ) : otherCommunities?.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">
          No other communities are listed on this server.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {otherCommunities?.map((entry) => (
            <CommunityCard domain={domain} entry={entry} key={entry.host} />
          ))}
        </div>
      )}
      {createOpen && selfServe.data?.enabled ? (
        <CreateCommunityDialog
          onClose={() => setCreateOpen(false)}
          status={selfServe.data}
        />
      ) : null}
    </div>
  );
}
