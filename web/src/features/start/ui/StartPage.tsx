/**
 * The one door for starting something.
 *
 * First comes the short form: a name, one sentence, the goal, and how everyone will know (`QuickStartForm`). It makes a
 * project one person can start alone. Every other way to start sits under "More ways to start", unchanged: a project
 * with reviewers and Shares, and the steps toward a raise in the order most projects take them, each ticked when the
 * person has really done it. Every step still opens the same screens as before.
 *
 * Where the build offers no raises (the contributor-only hosted image), the raise steps and their heading are left out, so
 * a contributor-only server never sends anyone to a sale it cannot launch; what is left is an unnumbered option.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Check } from "lucide-react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { isIdea } from "@/features/launchpad/lib/idea";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { hasFirstStep } from "@/shared/lib/first-steps";
import { existingUserPubkey } from "@/shared/lib/identity";
import { cn } from "@/shared/lib/cn";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";

import { QuickStartForm } from "./QuickStartForm";
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

function Step({
  step,
  index,
  numbered,
}: {
  step: StartStepView;
  index: number;
  /** Steps in an order get a number; options beside the main way to start do not. */
  numbered: boolean;
}) {
  return (
    <li
      className={cn(
        "flex gap-4 rounded-2xl border p-5",
        step.next ? "border-primary/60 bg-primary/5" : "border-border/60",
      )}
      data-testid={`start-step-${step.key}`}
    >
      {numbered || step.done ? (
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
      ) : null}
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

const MORE_KEY = "creaton.start.more";

/** Whether "More ways to start" was left open in this visit, so coming back to the page finds it as it was. */
function moreWasOpen(): boolean {
  try {
    return sessionStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberMore(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(MORE_KEY, "1");
    else sessionStorage.removeItem(MORE_KEY);
  } catch {
    // Not kept: the list starts closed next time.
  }
}

export function StartPage() {
  const [moreOpen] = useState(moreWasOpen);
  const me = existingUserPubkey();
  const launches = useLaunches();
  const mine = (launches.data ?? []).filter(
    (launch) => me !== null && launch.record.author === me,
  );
  const raises = raisesOffered();
  const steps = startSteps(
    {
      madeProject: hasFirstStep(localStorage, "project"),
      hasIdea: mine.some((launch) => isIdea(launch.record)),
      hasSale: mine.some((launch) => !isIdea(launch.record)),
    },
    raises,
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <PageHeader
        description="Say what you are aiming for. You can start alone, in about a minute."
        title="Start a project"
      />
      <QuickStartForm />
      <details
        className="group"
        data-testid="start-more"
        onToggle={(event) => rememberMore(event.currentTarget.open)}
        open={moreOpen}
      >
        <summary className="cursor-pointer text-sm font-semibold text-muted-foreground">
          More ways to start
        </summary>
        <div className="mt-4 flex flex-col gap-6">
          <section
            className="flex flex-col gap-3 rounded-2xl border border-border/60 p-5"
            data-testid="start-contributor"
          >
            <h2 className="text-base font-bold">Build with contributors</h2>
            <p className="text-sm text-muted-foreground">
              {raises
                ? "Start without a token sale. Set up work, choose reviewers, and award Shares, the project's voting tokens, through project votes. A page shows who was awarded how much and for what."
                : "Set up work and choose reviewers. Shares are votes in the project. The project votes to award them for work the reviewers accept. A page shows who was awarded how much and for what."}
            </p>
            <div>
              <Button
                asChild
                data-testid="start-go-contributor"
                size="sm"
                variant="outline"
              >
                <Link to="/start/contributor">Start a contributor project</Link>
              </Button>
            </div>
          </section>
          <h2 className="text-sm font-semibold text-muted-foreground">
            {raises ? "Or plan a raise, step by step" : "Other ways to begin"}
          </h2>
          {/* With raises these are steps in an order; without, the idea is an option beside the contributor project. */}
          {raises ? (
            <ol className="flex flex-col gap-3" data-testid="start-steps">
              {steps.map((step, index) => (
                <Step index={index} key={step.key} numbered step={step} />
              ))}
            </ol>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="start-steps">
              {steps.map((step, index) => (
                <Step
                  index={index}
                  key={step.key}
                  numbered={false}
                  step={step}
                />
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
