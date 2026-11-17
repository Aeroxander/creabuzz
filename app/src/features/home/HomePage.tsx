import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { APP_NAME } from "@creaton/core/brand.ts";
import { PenLine, Sprout } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Mark } from "../../app/Mark";
import { useAccount } from "../../lib/account";
import { useFollows } from "../../lib/follows";
import { useProfiles } from "../../lib/profiles";
import { investingOn } from "../../lib/server";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { ComposerSheet } from "../posts/Composer";
import { PostCard } from "../posts/PostCard";
import {
  engagementOf,
  useEngagement,
  useRecentPosts,
} from "../posts/use-posts";
import { ProjectCard } from "./ProjectCard";
import { useHomeProjects } from "./use-home";

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3"
      data-testid={testId}
    >
      <h2
        className="text-sm font-semibold uppercase tracking-wider text-muted"
        id={id}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Home: open rounds on top (a placeholder until the server reads the chain, milestone 5, and only where investing is
 * on), the projects you follow, the projects shipping now, and recent posts. Never sorted by money.
 */
export function HomePage() {
  const { pubkey } = useAccount();
  const requireAccount = useRequireAccount();
  const [composing, setComposing] = useState(false);
  const follows = useFollows().data;
  const projects = useHomeProjects();
  const followedPeople = follows ? [...follows.people] : [];
  const posts = useRecentPosts(
    followedPeople.length > 0 ? followedPeople : null,
  );
  const all = projects.data ?? [];
  const followed = all.filter((p) => follows?.projects.has(p.coordinate));
  const shipping = all
    .filter((p) => !follows?.projects.has(p.coordinate))
    .slice(0, 12);
  const postEvents = (posts.data ?? []).slice(0, 20);
  const profiles = useProfiles([
    ...all.map((p) => p.author),
    ...postEvents.map((e) => e.pubkey),
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

      {investingOn() ? (
        <Section testId="home-rounds" title="Open rounds">
          <Card
            className="flex flex-col gap-1"
            data-testid="rounds-placeholder"
          >
            <p className="font-semibold">Backing rounds show here</p>
            <p className="text-sm text-muted">
              Rounds open for 24 hours. They appear here once the server reads
              them from the network.
            </p>
          </Card>
        </Section>
      ) : null}

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
        {posts.isPending ? (
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
          postEvents.map((event) => (
            <PostCard
              engagement={engagementOf(engagement, event.id)}
              event={event}
              key={event.id}
              profiles={profiles}
            />
          ))
        )}
      </Section>

      <ComposerSheet onOpenChange={setComposing} open={composing} />
    </main>
  );
}
