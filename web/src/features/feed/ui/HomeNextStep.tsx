/**
 * Home's next step, for someone signed in: one line, one action.
 *
 * It says only what the app can check from signed records (`lib/project-state.ts`): handed-in work waiting for the
 * person's check, offers waiting for their reply, a task waiting for their yes, a team's invitation, a task of theirs
 * that is late or due soon, a weekly update that is due; or, when nothing ties them to a project yet, that they can
 * start one or help one. The most pressing is shown, where other people are waiting first.
 *
 * It can be put away for a day. Nothing shows while the facts are still being read, and a failed read is said, with
 * a retry, instead of "nothing needs you". It never arrives under a reader who has already scrolled down the page.
 */

import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import {
  dismissNextStep,
  nextStepDismissed,
} from "@/features/launchpad/lib/next-step";
import { positionNeeds } from "@/features/launchpad/lib/backing-positions";
import { needWords, orderNeeds } from "@/features/launchpad/lib/project-state";
import { NeedLink } from "@/features/launchpad/ui/NeedLink";
import { useBackingPositions } from "@/features/launchpad/use-backing-positions";
import { useMyNeeds } from "@/features/launchpad/use-my-projects";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

const ACTION_CLASS =
  "inline-flex shrink-0 items-center rounded-full bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground hover:bg-primary/90 max-sm:min-h-11 max-sm:px-4";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the reader has moved down Home: its timeline scrolls inside the social shell, not the window. */
export function readerScrolled(): boolean {
  const shell = document.querySelector('[data-testid="social-shell"]');
  return (shell?.scrollTop ?? 0) + window.scrollY > 8;
}

export function HomeNextStep({ me }: { me: string }) {
  const scope = `${relayWsUrl()}|${me}`;
  const [away, setAway] = useState(() =>
    nextStepDismissed(storage(), scope, Math.floor(Date.now() / 1000)),
  );
  const mine = useMyNeeds();
  // What a backer holds can ask for a step too (a window about to end, round tokens to exchange); with investing off
  // nothing is read and nothing is added.
  const backing = useBackingPositions();
  const needs = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const all = [
      ...mine.needs,
      ...backing.held.flatMap((h) =>
        positionNeeds(h.coordinate, h.position, now).map((need) => ({
          need,
          project: h.record,
        })),
      ),
    ];
    const byNeed = new Map(all.map((entry) => [entry.need, entry]));
    return orderNeeds(all.map((entry) => entry.need)).flatMap((need) => {
      const entry = byNeed.get(need);
      return entry ? [entry] : [];
    });
  }, [mine.needs, backing.held]);
  // The facts take a moment to read (seconds, on a busy server). A line that arrived then, above the timeline, would
  // push down what the reader had already scrolled to: so whether it may appear is settled once, when there is first
  // something to say, and only a reader still at the top of the page gets it this visit.
  const mayAppear = useRef<boolean | null>(null);
  const something =
    needs.length > 0 || mine.failed || (mine.ready && mine.noProject);
  if (something && mayAppear.current === null)
    mayAppear.current = !readerScrolled();
  if (away || (something && mayAppear.current === false)) return null;
  const putAway = () => {
    // Kept for a day where the browser allows; otherwise it is away for this visit.
    dismissNextStep(storage(), scope, Math.floor(Date.now() / 1000));
    setAway(true);
  };
  const first = needs[0];
  let body: React.ReactNode;
  if (first) {
    const words = needWords(first.need, first.project.name);
    body = (
      <>
        <p
          className="min-w-0 flex-1 break-words text-sm"
          data-testid="home-next-step-text"
        >
          {words.text}
        </p>
        {needs.length > 1 ? (
          <Link
            className="whitespace-nowrap text-sm underline"
            data-testid="home-next-step-more"
            to="/work"
          >
            {needs.length - 1} more waiting
          </Link>
        ) : null}
        <NeedLink
          className={ACTION_CLASS}
          need={first.need}
          project={first.project}
          testId="home-next-step-action"
        >
          {words.action}
        </NeedLink>
      </>
    );
  } else if (mine.failed) {
    return (
      <p className="text-sm" data-testid="home-next-step-failed" role="alert">
        Couldn't check what needs you in your projects.{" "}
        <Button onClick={mine.retry} size="sm" type="button" variant="outline">
          Try again
        </Button>
      </p>
    );
  } else if (!mine.ready) {
    return null;
  } else if (mine.noProject) {
    body = (
      <>
        <p className="min-w-0 flex-1 text-sm" data-testid="home-next-step-text">
          You have no project yet. Start one with four answers, or{" "}
          <Link
            className="underline"
            data-testid="home-next-step-work"
            to="/work"
          >
            find work on one
          </Link>
          .
        </p>
        <Link
          className={ACTION_CLASS}
          data-testid="home-next-step-action"
          to="/start"
        >
          Start a project
        </Link>
      </>
    );
  } else {
    // Nothing found that needs them: say nothing rather than a line with no action.
    return null;
  }
  return (
    <section
      aria-label="Next step"
      className="glass flex flex-wrap items-center gap-3 rounded-2xl border p-4"
      data-kind={first ? first.need.kind : "start"}
      data-testid="home-next-step"
    >
      {body}
      <Button
        aria-label="Not now: hide this for a day"
        data-testid="home-next-step-dismiss"
        onClick={putAway}
        size="sm"
        type="button"
        variant="ghost"
      >
        Not now
      </Button>
    </section>
  );
}
