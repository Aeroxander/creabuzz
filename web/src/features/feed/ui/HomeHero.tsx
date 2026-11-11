/**
 * The top of Home for someone who just arrived: one sentence on what this is, and two ways in. Start a project (four
 * answers; the account is asked for when it is needed) or find work on someone else's. What is happening right now
 * is the feed under it.
 *
 * Signed in, there is nothing here.
 */

import { Link } from "@tanstack/react-router";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

export function HomeHero() {
  return existingUserPubkey() ? null : <Welcome />;
}

function Welcome() {
  return (
    <section
      aria-labelledby="welcome-title"
      className="glass relative overflow-hidden rounded-2xl border px-5 py-6 sm:px-8 sm:py-8"
      data-testid="home-welcome"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.22),transparent_65%)]"
      />
      <h2
        className="max-w-xl text-3xl font-black leading-tight tracking-tight sm:text-4xl"
        id="welcome-title"
      >
        Real projects,{" "}
        <span className="text-[var(--brand-violet)]">built in the open.</span>
      </h2>
      <p className="mt-3 max-w-lg text-base text-muted-foreground">
        Every project here says what it will do, posts what it did each week,
        and shows whether it kept its word. Start yours, or lend a hand.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link data-testid="home-welcome-start" to="/start">
            Start a project
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link data-testid="home-welcome-work" to="/work">
            Find work
          </Link>
        </Button>
      </div>
    </section>
  );
}
