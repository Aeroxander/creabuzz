/**
 * The one door for starting something.
 *
 * Making a place to work, sharing an idea and raising money used to be three buttons on three pages with different
 * names. This page puts them in the order most projects take them, says what each is for, ticks the ones the person has
 * really done, and points at the next. Every step still opens the same screens as before; it only gathers them.
 */

import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { isIdea } from "@/features/launchpad/lib/idea";
import { hasFirstStep } from "@/shared/lib/first-steps";
import { existingUserPubkey } from "@/shared/lib/identity";
import { cn } from "@/shared/lib/cn";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";

import {
  startSteps,
  type StartStepView,
  type StartTarget,
} from "../lib/start-steps";

function StepLink({
  target,
  label,
  primary,
  testId,
}: {
  target: StartTarget;
  label: string;
  primary: boolean;
  testId: string;
}) {
  return (
    <Button
      asChild
      data-testid={testId}
      size="sm"
      variant={primary ? "default" : "outline"}
    >
      {target.to === "/c" ? (
        <Link to="/c">{label}</Link>
      ) : target.to === "/launchpad" ? (
        <Link search={{ start: target.start }} to="/launchpad">
          {label}
        </Link>
      ) : (
        <Link params={{ launchId: target.launchId }} to="/launchpad/$launchId">
          {label}
        </Link>
      )}
    </Button>
  );
}

function Step({ step, index }: { step: StartStepView; index: number }) {
  return (
    <li
      className={cn(
        "flex gap-4 rounded-2xl border p-5",
        step.next ? "border-primary/60 bg-primary/5" : "border-border/60",
      )}
      data-testid={`start-step-${step.key}`}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold",
          step.done
            ? "bg-primary text-primary-foreground"
            : "bg-foreground/10 text-foreground/70",
        )}
      >
        {step.done ? <Check className="h-4 w-4" /> : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-bold">{step.title}</h2>
          {step.done ? (
            <span className="text-xs font-medium text-muted-foreground">
              Done
            </span>
          ) : null}
          {step.next ? (
            <span
              className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary-ink"
              data-testid="start-next"
            >
              Next
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StepLink
            label={step.action}
            primary={step.next}
            target={step.target}
            testId={`start-go-${step.key}`}
          />
          {step.note ? (
            <span className="text-xs text-muted-foreground">{step.note}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function StartPage() {
  const me = existingUserPubkey();
  const launches = useLaunches();
  const mine = (launches.data ?? []).filter(
    (launch) => me !== null && launch.record.author === me,
  );
  const steps = startSteps({
    madeProject: hasFirstStep(localStorage, "project"),
    hasIdea: mine.some((launch) => isIdea(launch.record)),
    hasSale: mine.some((launch) => !isIdea(launch.record)),
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <PageHeader
        description="Most projects go in this order. You can begin at any step, and come back to the others later."
        title="Start something"
      />
      <section
        className="flex flex-col gap-3 rounded-2xl border border-primary/60 bg-primary/5 p-5"
        data-testid="start-contributor"
      >
        <h2 className="text-base font-bold">Build with contributors</h2>
        <p className="text-sm text-muted-foreground">
          Start without a token sale. Set up work, choose reviewers, and award
          Shares, the project&apos;s voting tokens, through project votes. A
          page shows who earned how much and for what.
        </p>
        <div>
          <Button asChild data-testid="start-go-contributor" size="sm">
            <Link to="/start/contributor">Start a contributor project</Link>
          </Button>
        </div>
      </section>
      <h2 className="text-sm font-semibold text-muted-foreground">
        Or plan a raise, step by step
      </h2>
      <ol className="flex flex-col gap-3" data-testid="start-steps">
        {steps.map((step, index) => (
          <Step index={index} key={step.key} step={step} />
        ))}
      </ol>
    </div>
  );
}
