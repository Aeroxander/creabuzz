import { APP_NAME } from "@creaton/core/brand.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { Sprout } from "lucide-react";
import { Mark } from "../../app/Mark";
import { useAccount } from "../../lib/account";
import { useProfiles } from "../../lib/profiles";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { ProjectCard } from "./ProjectCard";
import { useHomeProjects } from "./use-home";

/** Home: the projects, newest first (never sorted by money), and a way to start one. */
export function HomePage() {
  const { pubkey } = useAccount();
  const projects = useHomeProjects();
  const all = projects.data ?? [];
  const profiles = useProfiles(all.map((p) => p.author)).data;

  return (
    <main className="screen mx-auto flex max-w-lg flex-col gap-7">
      <header className="flex items-center gap-2.5 pt-2">
        <Mark size={30} />
        <span className="text-lg font-semibold tracking-tight">{APP_NAME}</span>
      </header>

      {pubkey ? <h1 className="sr-only">Home</h1> : null}
      {pubkey ? null : (
        <section className="flex flex-col gap-4" data-testid="home-welcome">
          <h1 className="headline text-4xl">
            Real projects,{" "}
            <span className="text-mint-ink">built in the open.</span>
          </h1>
          <ButtonLink block data-testid="home-start" to="/start">
            Start a project
          </ButtonLink>
        </section>
      )}

      <section
        aria-label="Projects"
        className="flex flex-col gap-3"
        data-testid="home-projects"
      >
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
        ) : all.length === 0 ? (
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
          all.map((project) => (
            <ProjectCard
              key={project.coordinate}
              profiles={profiles}
              project={project}
            />
          ))
        )}
      </section>
    </main>
  );
}
