/**
 * Discover — the directory this product opens on.
 *
 * "It's important everything is very visible, so that it's a fully
 * discoverable launchpad where people can join any project they find
 * interesting." Three sections in one screen, scan-first (cards, not
 * chrome), each answering the Paperclip questions in order: *what is
 * happening* (section description + card state), *does it need me* (stage,
 * open roles, seats), *what do I do about it* (one CTA per card, routing to
 * dialogs that already exist — nothing is rebuilt here).
 *
 * Honest edges: the counts line states every record that could not be
 * listed, each empty state says what would fill it, and a relay failure
 * renders `QueryError` instead of three empty grids that would read as
 * "nothing exists".
 */
import { useState, type ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";

import { PitchDialog } from "@/features/projects/ui/PitchDialog";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { useUserNames } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { QueryError, errorMessage } from "@/shared/ui/query-error";

import {
  directoryNotice,
  visibleSections,
  DISCOVER_EVENT_KINDS,
  type DiscoverFilter,
} from "../lib/directory";
import { useDiscover } from "../use-discover";
import {
  DiscoverDaoCard,
  DiscoverLaunchCard,
  DiscoverProjectCard,
} from "./DiscoverCards";

const FILTERS: readonly { id: DiscoverFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "daos", label: "DAOs" },
  { id: "fundraising", label: "Fundraising" },
  { id: "hiring", label: "Hiring" },
];

function EmptyState({
  testId,
  message,
  onPitch,
  children,
}: {
  testId: string;
  message: string;
  /** The default CTA: open the pitch dialog (pass `children` to override). */
  onPitch?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border border-dashed border-black/15 px-5 py-8 text-center dark:border-white/15"
      data-testid={testId}
    >
      <p className="text-sm text-black/60 dark:text-white/60">{message}</p>
      <div className="mt-3 flex justify-center">
        {children ?? (
          <Button onClick={onPitch} size="sm">
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Pitch a project
          </Button>
        )}
      </div>
    </div>
  );
}

function SectionHeading({
  title,
  count,
  description,
}: {
  title: string;
  count: number;
  description: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-base font-semibold text-black dark:text-white">
        {title}
        <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
          {count} listed
        </span>
      </h2>
      <p className="text-xs text-black/60 dark:text-white/60">{description}</p>
    </div>
  );
}

export function DiscoverPage() {
  const { data, isLoading, error, refetch } = useDiscover();
  const [filter, setFilter] = useState<DiscoverFilter>("all");
  const [pitchOpen, setPitchOpen] = useState(false);

  const sections = visibleSections(filter);
  const snapshot = data;
  const daos = snapshot?.daos ?? [];
  const launches = snapshot?.launches ?? [];
  const projects = snapshot?.projects ?? [];
  const founders = [
    ...daos.map((card) => card.founder),
    ...projects.map((card) => card.founder),
  ].filter((pubkey): pubkey is string => pubkey !== null);
  const nameOf = useUserNames(founders);
  const notice = snapshot ? directoryNotice(snapshot.counts) : null;
  const nothingHere =
    snapshot !== undefined &&
    daos.length === 0 &&
    launches.length === 0 &&
    projects.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <PageHeader
        action={
          <Button onClick={() => setPitchOpen(true)} size="sm">
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Pitch a project
          </Button>
        }
        description="Everything on this relay, in one place: the DAOs that already hold money, the launches raising now, and the projects hiring for a role. What is happening, whether it needs you, and the one click to join."
        title={
          <span className="flex items-center gap-2">
            <Search aria-hidden className="h-5 w-5" /> Discover
          </span>
        }
      />

      <div
        aria-label="Filter the directory"
        className="flex flex-wrap items-center gap-2"
        role="tablist"
      >
        {FILTERS.map((entry) => (
          <button
            aria-selected={filter === entry.id}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium tracking-wide",
              filter === entry.id
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
            )}
            key={entry.id}
            onClick={() => setFilter(entry.id)}
            role="tab"
            type="button"
          >
            <span data-testid={`discover-filter-${entry.id}`}>
              {entry.label}
            </span>
          </button>
        ))}
        <span className="ml-auto text-xs text-black/60 dark:text-white/60">
          {isLoading
            ? "Reading the relay…"
            : `${daos.length} DAOs · ${launches.length} launches · ${projects.length} projects`}
        </span>
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-black/60 dark:text-white/60">
          Loading the directory…
        </p>
      ) : error ? (
        <QueryError
          description="The relay did not answer the directory query — an empty grid here would claim there is nothing on this relay, so nothing is rendered instead."
          error={error}
          kinds={DISCOVER_EVENT_KINDS}
          message={errorMessage(error)}
          onRetry={refetch}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="discover-load-error"
          title="Couldn't read this relay"
        />
      ) : snapshot ? (
        <>
          {notice ? (
            <p
              className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
              data-testid="discover-counts"
            >
              {notice}
            </p>
          ) : null}

          {nothingHere ? (
            <EmptyState
              message="No projects on this relay yet — start one. A pitch, the roles you need, and it appears here for everyone reading this page."
              onPitch={() => setPitchOpen(true)}
              testId="discover-empty"
            />
          ) : (
            <>
              {sections.daos ? (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    count={daos.length}
                    description="Money already on chain: the address each project was summoned at, and the seats it minted."
                    title="DAOs"
                  />
                  {daos.length === 0 ? (
                    <EmptyState
                      message="No DAO summoned yet — one appears here the moment a project's launch graduates and its summon receipt lands."
                      testId="discover-daos-empty"
                    >
                      <Button asChild size="sm" variant="outline">
                        <Link
                          search={{ action: undefined, author: undefined }}
                          to="/launchpad"
                        >
                          Open the launchpad
                        </Link>
                      </Button>
                    </EmptyState>
                  ) : (
                    <ul
                      className="grid grid-cols-1 gap-4 md:grid-cols-2"
                      data-testid="discover-dao-list"
                    >
                      {daos.map((card) => (
                        <DiscoverDaoCard
                          card={card}
                          key={card.projectId}
                          nameOf={nameOf}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {sections.launches ? (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    count={launches.length}
                    description="Raises open for backing — stage, target, and progress straight from the record and the chain."
                    title="Live launches"
                  />
                  {launches.length === 0 ? (
                    <EmptyState
                      message="No live launches right now. Founders: publish one and this section fills with a stage, a target, and a way in."
                      testId="discover-launches-empty"
                    >
                      <Button asChild size="sm">
                        <Link
                          search={{ action: undefined, author: undefined }}
                          to="/launchpad"
                        >
                          <Plus className="mr-1 h-4 w-4" aria-hidden /> New
                          launch
                        </Link>
                      </Button>
                    </EmptyState>
                  ) : (
                    <ul
                      className="grid grid-cols-1 gap-4 md:grid-cols-2"
                      data-testid="discover-launch-list"
                    >
                      {launches.map((launch) => (
                        <DiscoverLaunchCard
                          key={`${launch.record.author}:${launch.record.id}`}
                          launch={launch}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {sections.projects ? (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    count={projects.length}
                    description="Pitches with the roles they need open — every chip is a seat you can ask for."
                    title="Open projects"
                  />
                  {projects.length === 0 ? (
                    <EmptyState
                      message="No projects on this relay yet — start one. Pitch the idea, the role you take, and the roles you need."
                      onPitch={() => setPitchOpen(true)}
                      testId="discover-projects-empty"
                    />
                  ) : (
                    <ul
                      className="grid grid-cols-1 gap-4 md:grid-cols-2"
                      data-testid="discover-project-list"
                    >
                      {projects.map((card) => (
                        <DiscoverProjectCard
                          card={card}
                          key={card.key}
                          nameOf={nameOf}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
            </>
          )}
        </>
      ) : null}

      <PitchDialog onOpenChange={setPitchOpen} open={pitchOpen} />
    </div>
  );
}
