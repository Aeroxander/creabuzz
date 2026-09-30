import * as React from "react";
import {
  AtSign,
  Bot,
  Check,
  Circle,
  Hash,
  MessageSquare,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";

import { useAppShell } from "@/app/AppShellContext";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type {
  GettingStartedAction,
  GettingStartedStep,
  GettingStartedStepId,
} from "@/features/home/lib/gettingStarted";
import { useGettingStartedSteps } from "@/features/home/useGettingStartedSteps";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

const STEP_ICONS: Record<GettingStartedStepId, LucideIcon> = {
  "open-channel": Hash,
  "say-hello": MessageSquare,
  "mention-agent": AtSign,
  "add-agent": Bot,
  "run-workflow": Workflow,
};

function useGettingStartedActionRunner() {
  const { openBrowseChannels, openCreateChannel } = useAppShell();
  const { goAgents, goChannel, goWorkflows } = useAppNavigation();

  return React.useCallback(
    (action: GettingStartedAction) => {
      switch (action.kind) {
        case "browse-channels":
          openBrowseChannels();
          return;
        case "create-channel":
          openCreateChannel();
          return;
        case "open-channel":
          void goChannel(action.channelId);
          return;
        case "open-agents":
          void goAgents();
          return;
        case "open-workflows":
          void goWorkflows();
          return;
        default: {
          const exhaustiveCheck: never = action;
          return exhaustiveCheck;
        }
      }
    },
    [goAgents, goChannel, goWorkflows, openBrowseChannels, openCreateChannel],
  );
}

function StepStatus({ step }: { step: GettingStartedStep }) {
  if (step.state === "done") {
    // The row title carries a visible "Done" badge, so no sr-only duplicate
    // here (one owner per screen-reader announcement — Rule 7).
    return (
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400"
        title="Done"
      >
        <Check aria-hidden className="h-4 w-4" />
      </span>
    );
  }

  if (step.state === "todo") {
    return (
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground"
        title="Not done yet"
      >
        <Circle aria-hidden className="h-3.5 w-3.5" />
        <span className="sr-only">Not done yet</span>
      </span>
    );
  }

  // No sound detector: an action link only — never a fake checkbox (Rule 1).
  const Icon = STEP_ICONS[step.id];
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
      <Icon aria-hidden className="h-4 w-4" />
    </span>
  );
}

function GettingStartedStepRow({
  onRunAction,
  step,
}: {
  onRunAction: (action: GettingStartedAction) => void;
  step: GettingStartedStep;
}) {
  return (
    <li
      className="flex min-w-0 items-start gap-3"
      data-testid={`getting-started-step-${step.id}`}
    >
      <StepStatus step={step} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium leading-5 text-foreground",
            step.state === "done" && "text-muted-foreground",
          )}
        >
          {step.title}
          {step.state === "done" ? (
            <span className="ml-2 text-2xs font-normal text-green-600 dark:text-green-400">
              Done
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {step.description}
        </p>
      </div>
      <Button
        className="shrink-0"
        onClick={() => onRunAction(step.action)}
        size="sm"
        type="button"
        variant={step.state === "done" ? "ghost" : "outline"}
        data-testid={`getting-started-step-${step.id}-action`}
      >
        {step.actionLabel}
      </Button>
    </li>
  );
}

/**
 * The getting-started checklist rows. Shared by the home card and the
 * Settings → Getting started panel so the two surfaces cannot drift.
 */
export function GettingStartedStepsList({
  currentPubkey,
}: {
  currentPubkey?: string;
}) {
  const steps = useGettingStartedSteps(currentPubkey);
  const runAction = useGettingStartedActionRunner();

  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {steps.map((step) => (
        <GettingStartedStepRow
          key={step.id}
          onRunAction={runAction}
          step={step}
        />
      ))}
    </ul>
  );
}

/**
 * Home-surface "Getting started" checklist card. Dismissible (persisted per
 * identity); reopening is available from Settings → Getting started.
 */
export function GettingStartedChecklist({
  currentPubkey,
  onDismiss,
}: {
  currentPubkey?: string;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Getting started"
      className="mx-4 mt-3 shrink-0 rounded-2xl border border-border/70 bg-card/70 px-4 py-3 shadow-xs sm:mx-6"
      data-testid="getting-started-card"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-5 text-foreground">
            Getting started
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            A few steps to get your bearings. Hide this anytime — it lives in
            Settings.
          </p>
        </div>
        <Button
          aria-label="Hide getting started checklist"
          className="shrink-0"
          onClick={onDismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
          data-testid="getting-started-dismiss"
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="mt-3">
        <GettingStartedStepsList currentPubkey={currentPubkey} />
      </div>
    </section>
  );
}
