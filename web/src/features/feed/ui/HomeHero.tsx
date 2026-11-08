/**
 * The top of Home for people who just arrived: a short pitch that leads with
 * what the product is for (talk with people, do useful work on their projects,
 * earn a say in them), two doors (make an account, look around) and the three
 * ideas it stands on.
 *
 * Signed in, there is nothing here: Home goes straight to the timeline.
 */

import { Link } from "@tanstack/react-router";
import { Coins, ShieldCheck, Users } from "lucide-react";

import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

const IDEAS = [
  {
    icon: Users,
    title: "Join the conversation",
    body: "Post, reply and vote on the boards of the projects you follow.",
  },
  {
    icon: ShieldCheck,
    title: "Do useful work",
    body: "Projects list work anyone can pick up. Reviewers check it, then the project votes on an award.",
  },
  {
    icon: Coins,
    title: "Earn a say",
    body: "Awards come as Shares, which let you vote on what the project does next.",
  },
] as const;

export function HomeHero() {
  return existingUserPubkey() ? null : <Welcome />;
}

function Welcome() {
  return (
    <section
      aria-labelledby="welcome-title"
      className="glass relative overflow-hidden rounded-2xl border px-5 py-6 sm:px-10 sm:py-10"
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
        Find projects.{" "}
        <span className="text-[var(--brand-violet)]">Help build them.</span>
      </h2>
      <p className="mt-3 max-w-lg text-base text-muted-foreground">
        Talk with the people behind projects you care about, pick up a piece of
        work, and earn a say in what they do next.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
          size="lg"
        >
          {CREATE_ACCOUNT}
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link to="/discover">Look around</Link>
        </Button>
      </div>
      <details className="mt-6" data-testid="home-welcome-ideas">
        <summary className="cursor-pointer text-sm font-semibold underline-offset-2 hover:underline">
          How it works
        </summary>
        <ul className="mt-4 grid gap-4 sm:grid-cols-3">
          {IDEAS.map(({ icon: Icon, title, body }) => (
            <li className="flex gap-3" key={title}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary-ink">
                <Icon aria-hidden className="h-4 w-4" />
              </span>
              <span>
                <span className="block text-sm font-bold">{title}</span>
                <span className="block text-sm text-muted-foreground">
                  {body}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
