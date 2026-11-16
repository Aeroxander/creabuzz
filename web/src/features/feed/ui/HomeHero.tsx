/**
 * The top of Home for someone who just arrived: one sentence on what this is, and a box to start in. The visitor types
 * what they are making and presses "Start a project"; Start opens with that goal filled in and the cursor in "Project
 * name". Nothing is sent until Start's own button. "Find work" is a quiet link beside it. When the server has a project
 * of its own, "See a record" opens its public page: the owner's listed project when this visitor can read the lists
 * (an open server), else the one the server names for itself (an invite-only server that lets anyone read a public
 * project's record). What is happening right now is the feed under it.
 *
 * Shown to every signed-out visitor, on every server. Signed in, there is nothing here.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { GOAL_LIMITS } from "@/features/launchpad/lib/goals";
import { projectSharePath } from "@/features/launchpad/lib/share";
import { existingUserPubkey } from "@/shared/lib/identity";
import {
  loadQuickStart,
  saveGoalToDraft,
} from "@/features/start/lib/quick-start";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { useExampleProject } from "../use-example-project";
import { useServerExample } from "../use-server-example";

export function HomeHero() {
  return existingUserPubkey() ? null : <Welcome />;
}

function Welcome() {
  // The server's own project, when it has one: a real record to read before deciding anything.
  const example = useExampleProject();
  // A visitor the server does not let read its lists cannot find that project: the server may name it instead.
  const named = useServerExample(example === null);
  const slug = example
    ? projectSharePath(example.record).slice("/p/".length)
    : named;
  const navigate = useNavigate();
  // What was already typed for Start (the visitor may have started there and come back) is the box's first value.
  const [goal, setGoal] = useState(() => loadQuickStart(sessionStorage).goal);
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
        Every project says what it will do, posts what it did each week, and
        shows whether it kept its word.
      </p>
      <form
        className="mt-5 flex max-w-xl flex-col gap-2"
        data-testid="home-welcome-form"
        onSubmit={(event) => {
          event.preventDefault();
          // The goal goes into Start's own draft; nothing is sent from here.
          saveGoalToDraft(sessionStorage, goal);
          void navigate({ to: "/start" });
        }}
      >
        <label className="text-sm font-medium" htmlFor="home-welcome-goal">
          What are you making?
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            className="h-10 bg-background max-sm:h-11 sm:flex-1"
            data-testid="home-welcome-goal"
            id="home-welcome-goal"
            maxLength={GOAL_LIMITS.text}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="A first version that ten people use."
            value={goal}
          />
          <Button
            className="max-sm:h-11"
            data-testid="home-welcome-start"
            size="lg"
            type="submit"
          >
            Start a project
          </Button>
        </div>
      </form>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        <Button asChild className="px-0 max-sm:h-11" variant="link">
          <Link data-testid="home-welcome-work" to="/work">
            Find work
          </Link>
        </Button>
        {slug ? (
          <Button asChild className="px-0 max-sm:h-11" variant="link">
            <Link
              data-testid="home-welcome-record"
              params={{ slug }}
              to="/p/$slug"
            >
              See a record
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
