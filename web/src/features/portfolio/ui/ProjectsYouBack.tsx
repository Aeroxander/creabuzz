/**
 * "Projects you back", under "Your projects": what the person holds in each project's backing, with the step that waits
 * on them (a milestone window about to end, round tokens to exchange). It is theirs to read, so it shows the amounts a
 * position is made of: units, what selling them now pays, and the part of their money held for the project. It leads with
 * nothing that moved, and the page above it, the record, comes first.
 *
 * It renders nothing at all when the build has investing off. The pools asked are those of the projects they follow, help
 * or started and the newest listed ones, bounded: a bound that cut the list is said, a read that failed is said with a
 * retry, and neither is ever shown as "you back nothing".
 */

import { Link } from "@tanstack/react-router";

import {
  money,
  unitsPhrase,
  whenWords,
} from "@/features/launchpad/lib/backing-copy";
import { investingOffered } from "@/features/launchpad/lib/investing-offered";
import { useBackingPositions } from "@/features/launchpad/use-backing-positions";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { SectionHeader } from "@/shared/ui/PageHeader";

export function ProjectsYouBack() {
  if (!investingOffered()) return null;
  return <ProjectsYouBackBody />;
}

function ProjectsYouBackBody() {
  const backing = useBackingPositions();
  return (
    <section
      aria-label="Projects you back"
      className="flex flex-col gap-3"
      data-testid="projects-you-back"
    >
      <SectionHeader title="Projects you back" />
      {backing.noAccount ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="projects-you-back-no-account"
        >
          Sign in, or connect an account, to see what you hold in a project's
          backing.
        </p>
      ) : backing.loading && backing.held.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          Reading what you hold…
        </p>
      ) : backing.held.length === 0 && backing.failed === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="projects-you-back-empty"
        >
          You hold no backing in the projects read here. When you back a
          project, it shows up here.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {backing.held.map(({ record, position }) => (
            <li key={`${record.author}:${record.id}`}>
              <Card
                className="flex h-full flex-col gap-1 p-4"
                data-testid="back-position"
              >
                <Link
                  className="text-base font-semibold underline-offset-2 hover:underline max-sm:inline-block max-sm:min-h-11 max-sm:py-2.5"
                  params={{ launchId: record.id }}
                  search={{ author: record.author }}
                  to="/launchpad/$launchId"
                >
                  {record.name}
                </Link>
                {position.units > 0n ? (
                  <p className="text-sm" data-testid="back-position-units">
                    You hold {unitsPhrase(position.units)}. Selling them now
                    pays {money(position.sellValue, position.quote)}.
                  </p>
                ) : null}
                {position.held > 0n ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="back-position-held"
                  >
                    {money(position.held, position.quote)} of what you paid is
                    held for the project.
                  </p>
                ) : null}
                {position.leaveBy !== null ? (
                  <p className="text-sm" data-testid="back-position-leave">
                    A milestone is open. You can stay or leave until{" "}
                    {whenWords(position.leaveBy)}.{" "}
                    <Link
                      className="font-medium underline"
                      hash="backing"
                      params={{ launchId: record.id }}
                      search={{ author: record.author }}
                      to="/launchpad/$launchId"
                    >
                      Stay or leave
                    </Link>
                  </p>
                ) : null}
                {position.claimTokens > 0n ? (
                  <p className="text-sm" data-testid="back-position-claim">
                    You hold round tokens from the opening round.{" "}
                    <Link
                      className="font-medium underline"
                      hash="backing"
                      params={{ launchId: record.id }}
                      search={{ author: record.author }}
                      to="/launchpad/$launchId"
                    >
                      Exchange them for units
                    </Link>
                  </p>
                ) : null}
                {position.phase === "abandoned" ? (
                  <p className="text-sm text-muted-foreground">
                    Backing has closed for good. Selling now also returns your
                    held money.
                  </p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {backing.failed > 0 ? (
        <p
          className="text-sm"
          data-testid="projects-you-back-failed"
          role="alert"
        >
          Couldn't read what you hold in {backing.failed}{" "}
          {backing.failed === 1 ? "project" : "projects"}, so{" "}
          {backing.failed === 1 ? "it is" : "they are"} missing here.{" "}
          <Button
            className="max-sm:h-11"
            onClick={backing.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : null}
      {backing.cut ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="projects-you-back-cut"
          role="status"
        >
          Only the projects you follow, help or started and the newest listed
          ones are read, so a project you back elsewhere may not be here. Follow
          it to be sure.
        </p>
      ) : null}
    </section>
  );
}
