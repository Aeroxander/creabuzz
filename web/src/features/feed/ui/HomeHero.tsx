/**
 * The top of Home: what this place is for people who just arrived, and what to
 * do next for people who just signed up.
 *
 * Signed out: a short pitch, two doors (make an account, look around) and the
 * three ideas the product stands on (a ready-made team, helpers that ask first,
 * and sharing ownership when the time comes). Signed in: a checklist built only from
 * things the app can verify (a profile, a follow, a launch of your own), so a
 * ticked box never lies. It can be dismissed, and goes away on its own when done.
 */

import { Link } from "@tanstack/react-router";
import { Bot, Check, Coins, Users } from "lucide-react";
import { useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";

import { followedLaunches, followedPeople } from "../lib/lists";
import { useMyLists } from "../use-feed";

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
    icon: Users,
    title: "Start from a ready-made team",
    body: "Pick a film crew, an app team or a startup crew. Channels, helpers and a shared wiki are set up for you.",
  },
  {
    icon: Bot,
    title: "AI helpers that ask first",
    body: "Helpers do the legwork. When one reaches its limit it asks you before going on, so nothing runs away.",
  },
  {
    icon: Coins,
    title: "Share what you build",
    body: "When you're ready, raise money and share ownership with the people who back and build it.",
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
      className="glass relative overflow-hidden rounded-2xl border px-6 py-8 sm:px-10 sm:py-10"
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
        Make something with a team of people and{" "}
        <span className="text-[var(--brand-violet)]">AI helpers</span>
      </h2>
      <p className="mt-3 max-w-lg text-base text-muted-foreground">
        Creaton is a shared workspace where you plan, make and ship together. AI
        helpers do the legwork inside a budget you set, and when you're ready
        you can share ownership with the people who help build it.
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
      <ul className="mt-8 grid gap-4 sm:grid-cols-3">
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
      label: "Start an idea of your own",
      hint: "A name and a sentence. About a minute, nothing to commit to.",
      to: "/launchpad" as const,
    },
  ];
  if (steps.every((step) => step.done)) return null;

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
