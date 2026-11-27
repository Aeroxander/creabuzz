import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { APP_NAME } from "@creaton/core/brand.ts";
import { PenLine, Search, Sprout } from "lucide-react";
import { useMemo, useState } from "react";
import { Mark } from "../../app/Mark";
import { useAccount } from "../../lib/account";
import { useFollows } from "../../lib/follows";
import { useProfiles } from "../../lib/profiles";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { LazyComposer } from "../posts/LazyComposer";
import { PostCard } from "../posts/PostCard";
import {
  engagementOf,
  feedRows,
  useEngagement,
  useRecentPosts,
  useReposts,
} from "../posts/use-posts";
import { useVisibleRows } from "../safety/use-hidden";
import { SeasonBand } from "../season/SeasonBand";
import { ProjectCard } from "./ProjectCard";
import { RankedSection } from "./RankedSection";
import { Section } from "./Section";
import { useHomeProjects } from "./use-home";
import { useRanking } from "./use-ranking";

/**
 * Home: the projects you follow, the money that stayed (the one place a list is sorted by money, and by money that has stayed,
 * never by a price), the projects shipping now (newest first, never sorted by money), and recent posts.
 */
export function HomePage() {
  const { pubkey } = useAccount();
  const requireAccount = useRequireAccount();
  const [composing, setComposing] = useState(false);
  const follows = useFollows().data;
  const projects = useHomeProjects();
  const ranking = useRanking();
  const followedPeople = follows ? [...follows.people] : [];
  const posts = useRecentPosts(
    followedPeople.length > 0 ? followedPeople : null,
  );
  // Reposts are extra: a read that fails leaves the posts as they are.
  const reposts = useReposts(followedPeople.length > 0 ? followedPeople : null);
  const all = projects.data ?? [];
  const followed = all.filter((p) => follows?.projects.has(p.coordinate));
  const shipping = all
    .filter((p) => !follows?.projects.has(p.coordinate))
    .slice(0, 12);
  // Posts of people this person hid, and posts they reported, are left out here as everywhere.
  const rows = useMemo(
    () => feedRows(posts.data, reposts.data),
    [posts.data, reposts.data],
  );
  const visible = useVisibleRows(rows);
  const postRows = visible.shown.slice(0, 20);
  const postEvents = postRows.map((row) => row.event);
  const profiles = useProfiles([
    ...all.map((p) => p.author),
    ...postRows.flatMap((row) =>
      row.repostedBy
        ? [row.event.pubkey, row.repostedBy.pubkey]
        : [row.event.pubkey],
    ),
  ]).data;
  const engagement = useEngagement(postEvents.map((e) => e.id)).data;

  return (
    <main className="screen mx-auto flex max-w-lg flex-col gap-7">
      <header className="flex items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-2.5">
          <Mark size={30} />
          <span className="text-lg font-semibold tracking-tight">
            {APP_NAME}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ButtonLink
            aria-label="Search"
            data-testid="home-search"
            size="sm"
            to="/search"
            variant="secondary"
          >
            <Search aria-hidden="true" size={16} />
          </ButtonLink>
          <Button
            aria-label="Write a post"
            data-testid="home-compose"
            onClick={() => requireAccount(() => setComposing(true))}
            size="sm"
            variant="secondary"
          >
            <PenLine aria-hidden="true" size={16} />
            Post
          </Button>
        </div>
      </header>

      {pubkey ? <h1 className="sr-only">Home</h1> : null}
      {pubkey ? null : (
        <section className="flex flex-col gap-4" data-testid="home-welcome">
          <h1 className="headline text-4xl">
            Real projects,{" "}
            <span className="text-mint-ink">built in the open.</span>
          </h1>
          <p className="text-muted">
            Every project says what it will do, posts what it did each week, and
            shows whether it kept its word.
          </p>
          <ButtonLink block data-testid="home-start" to="/start">
            Start a project
          </ButtonLink>
        </section>
      )}

      <SeasonBand />

      {followed.length > 0 ? (
        <Section testId="home-following" title="Projects you follow">
          {followed.map((project) => (
            <ProjectCard
              key={project.coordinate}
              profiles={profiles}
              project={project}
            />
          ))}
        </Section>
      ) : null}

      <RankedSection ranking={ranking.data} />

      <Section testId="home-projects" title="Shipping now">
        {projects.isPending ? (
          <Card className="h-28 animate-pulse" />
        ) : projects.isError ? (
          <EmptyState
            action={
              <Button
                onClick={() => void projects.refetch()}
                variant="secondary"
              >
                Try again
              </Button>
            }
            title="Projects could not be read"
          >
            {readFailureWords(projects.error).text}
          </EmptyState>
        ) : shipping.length === 0 && followed.length === 0 ? (
          <EmptyState
            action={
              // Signed out, the welcome above already has the green Start; secondary here keeps one green per screen.
              pubkey ? (
                <ButtonLink
                  data-testid="home-empty-start"
                  to="/start"
                  variant="secondary"
                >
                  Start a project
                </ButtonLink>
              ) : null
            }
            icon={<Sprout size={28} />}
            title="No projects yet"
          >
            Be the first: say what you are making.
          </EmptyState>
        ) : (
          shipping.map((project) => (
            <ProjectCard
              key={project.coordinate}
              profiles={profiles}
              project={project}
            />
          ))
        )}
      </Section>

      <Section
        testId="home-posts"
        title={
          followedPeople.length > 0
            ? "Posts from people you follow"
            : "Recent posts"
        }
      >
        {posts.isPending || !visible.ready ? (
          <Card className="h-24 animate-pulse" tone="plain" />
        ) : posts.isError ? (
          <EmptyState
            action={
              <Button onClick={() => void posts.refetch()} variant="secondary">
                Try again
              </Button>
            }
            title="Posts could not be read"
          >
            {readFailureWords(posts.error).text}
          </EmptyState>
        ) : postEvents.length === 0 ? (
          <p className="px-1 text-sm text-muted">No posts yet.</p>
        ) : (
          postRows.map((row) => (
            <PostCard
              engagement={engagementOf(engagement, row.event.id)}
              event={row.event}
              key={row.event.id}
              profiles={profiles}
              repostedBy={row.repostedBy}
            />
          ))
        )}
      </Section>

      <LazyComposer onOpenChange={setComposing} open={composing} />
    </main>
  );
}
