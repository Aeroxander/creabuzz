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
import { useEffect, useState, type ReactNode } from "react";

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Lightbulb, Plus, Search } from "lucide-react";

import { isIdea } from "@/features/launchpad/lib/idea";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { StartIdeaDialog } from "@/features/launchpad/ui/StartIdeaDialog";
import { PitchDialog } from "@/features/projects/ui/PitchDialog";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { useUserNames } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { CategoryBrowse } from "./CategoryBrowse";

import {
  directoryNotice,
  discoverFilters,
  launchesForFilter,
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
import { countOf } from "@/shared/lib/count-of";

/** The contributor-only build's one way to start something: a contributor project. */
function StartProjectButton({ variant }: { variant?: "outline" }) {
  return (
    <Button asChild size="sm" variant={variant}>
      <Link data-testid="discover-start-project" to="/start/contributor">
        <Plus className="mr-1 h-4 w-4" aria-hidden /> Start a project
      </Link>
    </Button>
  );
}

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
        <span className="ml-2 text-xs font-normal text-black/60 dark:text-white/60">
          {count} listed
        </span>
      </h2>
      <p className="text-xs text-black/60 dark:text-white/60">{description}</p>
    </div>
  );
}

export function DiscoverPage() {
  const { data, isLoading, error, refetch } = useDiscover();
  // A contributor-only build (the hosted pilot) lists no raise, offers no backing and no pitch board: its projects are
  // contributor projects, and starting one is the only way in.
  const raises = raisesOffered();
  const [filter, setFilter] = useState<DiscoverFilter>("all");
  const [pitchOpen, setPitchOpen] = useState(false);
  // `?start=idea` (the Start page's "Share an idea", where a contributor-only build sends it here) opens the idea dialog
  // once; a build with raises keeps it on the launchpad.
  const startIdea =
    (useSearch({ strict: false }) as { start?: unknown }).start === "idea";
  const [ideaOpen, setIdeaOpen] = useState(startIdea && !raises);
  const navigate = useNavigate();
  useEffect(() => {
    // Dropped once read, so a reload does not open the dialog again.
    if (startIdea) void navigate({ to: "/discover", replace: true });
  }, [startIdea, navigate]);

  const sections = visibleSections(filter, raises);
  const snapshot = data;
  const daos = snapshot?.daos ?? [];
  const allLaunches = snapshot?.launches ?? [];
  const launches = launchesForFilter(allLaunches, filter, raises);
  const projects = snapshot?.projects ?? [];
  const founders = [
    ...daos.map((card) => card.founder),
    ...projects.map((card) => card.founder),
  ].filter((pubkey): pubkey is string => pubkey !== null);
  const nameOf = useUserNames(founders);
  const notice = snapshot ? directoryNotice(snapshot.counts) : null;
  const nothingHere =
    snapshot !== undefined &&
    // A contributor-only build shows no DAOs section, so its DAOs cannot fill the page there.
    (daos.length === 0 || !raises) &&
    allLaunches.length === 0 &&
    // The pitch board is not shown where raises are not offered, so its pitches cannot fill the page there.
    (projects.length === 0 || !raises);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
      <PageHeader
        action={
          raises ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/launchpad" data-testid="discover-launches">
                  Launches
                </Link>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link data-testid="discover-board" to="/projects">
                  Project board
                </Link>
              </Button>
              <Button onClick={() => setPitchOpen(true)} size="sm">
                <Plus className="mr-1 h-4 w-4" aria-hidden /> Pitch a project
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="discover-share-idea-header"
                onClick={() => setIdeaOpen(true)}
                size="sm"
                variant="outline"
              >
                <Lightbulb aria-hidden className="mr-1 h-4 w-4" /> Share an idea
              </Button>
              <StartProjectButton />
            </div>
          )
        }
        description={
          raises
            ? "Everything on this server in one place: projects that already hold shared money, raises open now, and projects looking for people."
            : "Projects on this server and the people they need."
        }
        title={
          <span className="flex items-center gap-2">
            <Search aria-hidden className="h-5 w-5" /> Discover
          </span>
        }
      />

      <div
        aria-label="Filter what is shown"
        className="flex flex-wrap items-center gap-x-6 gap-y-2"
        role="tablist"
      >
        {discoverFilters(raises).map((entry) => (
          <button
            aria-selected={filter === entry.id}
            className={cn(
              "border-b-[3px] px-1 pb-1.5 text-base font-semibold transition-colors",
              filter === entry.id
                ? "border-primary text-foreground"
                : "border-transparent text-foreground/60 hover:text-foreground",
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
            ? "Loading…"
            : raises
              ? `${countOf(daos.length, "DAO")} · ${countOf(launches.length, "launch", "launches")} · ${countOf(projects.length, "project")}`
              : `${countOf(allLaunches.filter((l) => !isIdea(l.record)).length, "project")} · ${countOf(allLaunches.filter((l) => isIdea(l.record)).length, "idea")}`}
        </span>
      </div>

      <CategoryBrowse />

      {isLoading ? (
        <p className="py-8 text-center text-sm text-black/60 dark:text-white/60">
          Loading…
        </p>
      ) : error ? (
        <QueryError
          description="The server didn't answer, so we can't show what is here."
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
          title="Couldn't load this page"
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
            raises ? (
              <EmptyState
                message="No projects on this server yet. Start one: add a pitch and the roles you need, and it shows up here for everyone."
                onPitch={() => setPitchOpen(true)}
                testId="discover-empty"
              />
            ) : (
              <EmptyState
                message="No projects on this server yet. Start one and it shows up here."
                testId="discover-empty"
              >
                <StartProjectButton />
              </EmptyState>
            )
          ) : (
            <>
              {sections.launches ? (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    count={launches.length}
                    description={
                      raises
                        ? "Raises open for backing, with their stage, target and progress as the sale itself reports them."
                        : filter === "ideas"
                          ? "Ideas people shared before starting a project."
                          : "Projects looking for people to help, and ideas shared before one starts."
                    }
                    title={
                      raises
                        ? "Live launches"
                        : filter === "ideas"
                          ? "Ideas"
                          : "Projects"
                    }
                  />
                  {launches.length === 0 && !raises ? (
                    <EmptyState
                      message={
                        filter === "ideas"
                          ? "No ideas yet. Share one and it shows up here."
                          : "No projects yet. Start one and it shows up here."
                      }
                      testId="discover-launches-empty"
                    >
                      {filter === "ideas" ? (
                        <Button
                          data-testid="discover-share-idea"
                          onClick={() => setIdeaOpen(true)}
                          size="sm"
                        >
                          <Lightbulb aria-hidden className="mr-1 h-4 w-4" />{" "}
                          Share an idea
                        </Button>
                      ) : (
                        <StartProjectButton />
                      )}
                    </EmptyState>
                  ) : launches.length === 0 ? (
                    <EmptyState
                      message="No live launches right now. Publish one and it shows up here with its stage, target, and a way to back it."
                      testId="discover-launches-empty"
                    >
                      <Button asChild size="sm">
                        <Link to="/launchpad">
                          <Plus className="mr-1 h-4 w-4" aria-hidden /> New
                          launch
                        </Link>
                      </Button>
                    </EmptyState>
                  ) : (
                    <ul
                      className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3"
                      data-testid="discover-launch-list"
                    >
                      {launches.map((launch) => (
                        <DiscoverLaunchCard
                          key={`${launch.record.author}:${launch.record.id}`}
                          launch={launch}
                          raises={raises}
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
                    description="Pitches with the roles they need. Each tag is a role you can ask to join."
                    title="Project board"
                  />
                  {projects.length === 0 ? (
                    <EmptyState
                      message="No projects on this server yet. Start one. Pitch the idea, the role you take, and the roles you need."
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
              {sections.daos ? (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    count={daos.length}
                    description="A DAO is a project run by its holders' votes, with its money held in the open."
                    title="DAOs"
                  />
                  {daos.length === 0 ? (
                    <EmptyState
                      message="No projects with shared funds yet. One shows up here once it is set up."
                      testId="discover-daos-empty"
                    >
                      {raises ? (
                        <Button asChild size="sm" variant="outline">
                          <Link to="/launchpad">Open the launchpad</Link>
                        </Button>
                      ) : (
                        <StartProjectButton variant="outline" />
                      )}
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
            </>
          )}
        </>
      ) : null}

      {raises ? (
        <PitchDialog onOpenChange={setPitchOpen} open={pitchOpen} />
      ) : null}
      {ideaOpen ? <StartIdeaDialog onClose={() => setIdeaOpen(false)} /> : null}
    </div>
  );
}
