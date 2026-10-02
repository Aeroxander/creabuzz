/**
 * The top of Home: what this place is for people who just arrived, and what to
 * do next for people who just signed up.
 *
 * Signed out: a short pitch, two doors (browse the raises, start one) and the
 * three ideas the product stands on. Signed in: a checklist built only from
 * things the app can verify (a profile, a follow, a launch of your own), so a
 * ticked box never lies. It can be dismissed, and goes away on its own when done.
 */

import { Link } from "@tanstack/react-router";
import { Check, Coins, HandCoins, Vote } from "lucide-react";
import { useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { followedLaunches, followedPeople } from "../lib/lists";
import { useMyLists } from "../use-feed";

/** Asks the profile menu to open its sign-up dialog (it owns that flow). */
export const SIGN_UP_EVENT = "creaton:sign-up";

const DISMISSED_KEY = "creaton.home.getting-started.dismissed";

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
    title: "Own a piece",
    body: "Back a project early and hold a real share of what it becomes.",
  },
  {
    icon: Vote,
    title: "Decide together",
    body: "Holders vote on how the treasury is spent, and can always exit.",
  },
  {
    icon: HandCoins,
    title: "Get paid for work",
    body: "Do the work, have it accepted, and earn credit and royalties.",
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
      className="relative overflow-hidden rounded-2xl border border-border bg-card px-6 py-8 sm:px-10 sm:py-10"
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
        Back the projects you believe in,{" "}
        <span className="text-[var(--brand-violet)]">together</span>
      </h2>
      <p className="mt-3 max-w-lg text-base text-muted-foreground">
        Creaton is where teams raise money, share ownership and get work done in
        the open — with people and AI agents at the same table.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link
            search={{ action: undefined, author: undefined }}
            to="/launchpad"
          >
            Explore launches
          </Link>
        </Button>
        <Button
          onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
          size="lg"
          variant="outline"
        >
          Create your account
        </Button>
      </div>
      <ul className="mt-8 grid gap-4 sm:grid-cols-3">
        {IDEAS.map(({ icon: Icon, title, body }) => (
          <li className="flex gap-3" key={title}>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
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
    </section>
  );
}

function GettingStarted({ me }: { me: string }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const lists = useMyLists();
  const launches = useLaunches();
  const { data: profiles } = useProfiles([me]);

  const profile = profiles?.[me];
  const named = Boolean(
    profile && resolveUserName(profile, me) !== me.slice(0, 8),
  );
  const follows =
    followedPeople(lists.data?.contacts ?? null).size +
      followedLaunches(lists.data?.bookmarks ?? null).size >
    0;
  const started = (launches.data ?? []).some((l) => l.record.author === me);

  // Don't flash a checklist of empty boxes while the answers are still loading.
  if (dismissed || lists.isLoading || launches.isLoading || !profiles) {
    return null;
  }

  const steps = [
    {
      done: named,
      label: "Add your name and a picture",
      hint: "Open your account menu, top right.",
      to: null,
    },
    {
      done: follows,
      label: "Follow a launch or a person",
      hint: "Their posts will show up in For you.",
      to: "/discover" as const,
    },
    {
      done: started,
      label: "Start a launch of your own",
      hint: "A pitch, a split, a raise — about five minutes.",
      to: "/launchpad" as const,
    },
  ];
  if (steps.every((step) => step.done)) return null;

  return (
    <section
      aria-labelledby="getting-started-title"
      className="rounded-2xl border border-border bg-card p-5"
      data-testid="home-getting-started"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold" id="getting-started-title">
            Get started
          </h2>
          <p className="text-sm text-muted-foreground">
            {steps.filter((s) => s.done).length} of {steps.length} done
          </p>
        </div>
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
      <ol className="mt-3 flex flex-col gap-2">
        {steps.map((step) => (
          <li
            className="flex items-center gap-3 rounded-xl bg-secondary/50 px-3 py-2.5"
            key={step.label}
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
