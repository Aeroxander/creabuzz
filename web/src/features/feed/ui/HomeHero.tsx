/**
 * The top of Home: what this place is for people who just arrived, and what to
 * do next for people who just signed up.
 *
 * Signed out: a short pitch that leads with what the product is for (back a
 * project early, and watch the team's tokens unlock as its milestones are
 * reached), two doors (make an account, look around) and the three ideas it
 * stands on. Signed in: a checklist built only from things the app can verify,
 * so a ticked box never lies. It asks different things of someone who came to back
 * projects and someone who came to build one (`lib/home-steps.ts`): a backer is
 * never asked to start a project or run an AI helper. It can be dismissed, and goes
 * away on its own when the way in is done.
 */

import { Link } from "@tanstack/react-router";
import { Check, Coins, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { peekAgentPubkey } from "@/shared/lib/agent-identity";
import { hasFirstStep } from "@/shared/lib/first-steps";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";

import {
  type Role,
  type Signals,
  parseRole,
  stepsFor,
  wayInDone,
} from "../lib/home-steps";
import { followedLaunches, followedPeople } from "../lib/lists";
import { useMyLists } from "../use-feed";

const DISMISSED_KEY = "creaton.home.getting-started.dismissed";
const ROLE_KEY = "creaton.home.role";

function readRole(): Role {
  try {
    return parseRole(localStorage.getItem(ROLE_KEY));
  } catch {
    return parseRole(null);
  }
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

const IDEAS = [
  {
    icon: Coins,
    title: "Back a project early",
    body: "Bid in an open sale. If it misses its minimum, every bid is refunded.",
  },
  {
    icon: ShieldCheck,
    title: "The team's tokens unlock with its milestones",
    body: "The team's own tokens stay locked. The team publishes evidence and posts a bond, and the tokens unlock after an objection period unless holders successfully challenge the claim. A project can instead name reviewers who approve each milestone.",
  },
  {
    icon: Users,
    title: "Build together",
    body: "Start from a ready-made team. AI helpers do the legwork and ask before they go past their limit.",
  },
] as const;

export function HomeHero() {
  const me = existingUserPubkey();
  return me ? <GettingStarted me={me} /> : <Welcome />;
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
        Back teams.{" "}
        <span className="text-[var(--brand-violet)]">
          Follow what they build.
        </span>
      </h2>
      <p className="mt-3 max-w-lg text-base text-muted-foreground">
        Back early projects, follow their progress, and see the team&apos;s
        tokens unlock as its milestones are reached. A defined part of the
        team&apos;s tokens stays locked until each agreed milestone has been
        delivered and judged.
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

function GettingStarted({ me }: { me: string }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [role, setRole] = useState<Role>(readRole);
  const lists = useMyLists();
  const launches = useLaunches();
  const { data: profiles } = useProfiles([me]);

  const profile = profiles?.[me];
  const mine = (launches.data ?? []).filter((l) => l.record.author === me);
  const signals: Signals = {
    named: Boolean(profile && resolveUserName(profile, me) !== me.slice(0, 8)),
    lookedAtProject: hasFirstStep(localStorage, "looked-at-project"),
    follows:
      followedPeople(lists.data?.contacts ?? null).size +
        followedLaunches(lists.data?.bookmarks ?? null).size >
      0,
    backed: (launches.data ?? []).some((l) =>
      l.bids.some((bid) => bid.author === me),
    ),
    published: mine.length > 0,
    setUpMilestones: mine.some((l) => l.record.unlocks?.mode === "milestones"),
    madeWorkspace: hasFirstStep(localStorage, "project"),
    ranHelper: peekAgentPubkey() !== null,
  };

  // Don't flash a checklist of empty boxes while the answers are still loading.
  if (dismissed || lists.isLoading || launches.isLoading || !profiles) {
    return null;
  }

  const steps = stepsFor(role, signals);
  if (wayInDone(steps)) return null;
  const required = steps.filter((step) => !step.optional);

  const chooseRole = (next: Role) => {
    setRole(next);
    try {
      localStorage.setItem(ROLE_KEY, next);
    } catch {
      // Not remembered; it simply starts as a backer next visit.
    }
  };

  return (
    <section
      aria-labelledby="getting-started-title"
      className="glass rounded-2xl border p-5"
      data-testid="home-getting-started"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold" id="getting-started-title">
            Get started
          </h2>
          <p className="text-sm text-muted-foreground">
            {required.filter((s) => s.done).length} of {required.length} done
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button asChild size="sm" variant="outline">
            <Link data-testid="home-start-link" to="/start">
              All the ways to start
            </Link>
          </Button>
          <Button
            onClick={() => {
              try {
                localStorage.setItem(DISMISSED_KEY, "1");
              } catch {
                // Not remembered; it simply shows again next visit.
              }
              setDismissed(true);
            }}
            size="sm"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      </div>
      <fieldset className="mt-3 inline-flex rounded-full bg-secondary/60 p-0.5 text-sm">
        <legend className="sr-only">Why you are here</legend>
        {(
          [
            ["backer", "I want to back projects"],
            ["founder", "I'm building a project"],
          ] as const
        ).map(([value, label]) => (
          <button
            aria-pressed={role === value}
            className={`rounded-full px-3 py-1 font-medium ${
              role === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            }`}
            data-testid={`home-role-${value}`}
            key={value}
            onClick={() => chooseRole(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </fieldset>
      <ol className="mt-3 flex flex-col gap-2">
        {steps.map((step) => (
          <li
            className="flex items-center gap-3 rounded-xl bg-secondary/50 px-3 py-2.5"
            data-testid={`home-step-${step.id}`}
            key={step.id}
          >
            <span
              aria-hidden
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${
                step.done
                  ? "bg-primary text-primary-foreground"
                  : "border border-border"
              }`}
            >
              {step.done ? <Check className="h-3.5 w-3.5" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`block text-sm font-semibold ${step.done ? "text-muted-foreground line-through" : ""}`}
              >
                {step.label}
              </span>
              <span className="block text-xs text-muted-foreground">
                {step.hint}
              </span>
            </span>
            {!step.done && step.to ? (
              <Button asChild size="sm" variant="outline">
                <Link
                  search={
                    step.to === "/launchpad"
                      ? { action: undefined, author: undefined }
                      : undefined
                  }
                  to={step.to}
                >
                  Go
                </Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
