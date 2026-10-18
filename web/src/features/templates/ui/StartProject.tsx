/**
 * Set up the current community: pick a ready-made team and preview its additions.
 *
 * The picker shows the bundled templates (channels, AI helpers, shared pages, a
 * default limit for the helpers) in plain words and says who each is for. After
 * checking your role, setup writes as you, one step at a time, shows each step,
 * and, if the server refuses one, says which and what to do, keeps what went
 * through, and lets the same button pick up from there.
 *
 * What the steps are and how they are written is decided in
 * `@creaton/core/templates`; this file only shows it.
 */

import { Check, CircleAlert, Loader2, Users } from "lucide-react";
import { useState } from "react";

import { TEMPLATE_INDEX } from "@creaton/core/templates/catalog-index.generated.ts";
import type { TemplateSummary } from "@creaton/core/templates/schema.ts";
import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  describeDefaultLimit,
  templateAudience,
  templateCounts,
  templateTitle,
} from "../lib/template-copy";
import type { StepResult, StepStatus } from "../lib/run-plan";
import { useTemplateApply } from "../use-template-apply";

export type ProjectDestination = "agents" | "org" | "wiki";

const STATUS_WORDS: Record<StepStatus, string> = {
  created: "Done",
  skipped: "Already there",
  "needs-cli": "Needs the command line",
  failed: "Stopped",
  "not-attempted": "Waiting",
};

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "created" || status === "skipped") {
    return <Check aria-hidden className="h-4 w-4 text-primary" />;
  }
  if (status === "failed") {
    return <CircleAlert aria-hidden className="h-4 w-4 text-destructive" />;
  }
  return (
    <span
      aria-hidden
      className="h-2 w-2 rounded-full border border-muted-foreground/60"
    />
  );
}

function Progress({ results, busy }: { results: StepResult[]; busy: boolean }) {
  const doneCount = results.filter(
    (r) => r.status === "created" || r.status === "skipped",
  ).length;
  return (
    <div data-testid="start-project-progress">
      <p className="text-sm text-muted-foreground" role="status">
        {busy
          ? `Setting things up… ${doneCount} of ${results.length}`
          : `${doneCount} of ${results.length} done`}
      </p>
      <ol className="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto text-sm">
        {results.map((result) => (
          <li
            className="flex items-center gap-2"
            key={`${result.step.kind}:${result.step.item}`}
          >
            <StepIcon status={result.status} />
            <span
              className={
                result.status === "not-attempted"
                  ? "text-muted-foreground"
                  : undefined
              }
            >
              {result.label}
            </span>
            {result.status === "skipped" ||
            result.status === "needs-cli" ||
            result.status === "failed" ? (
              <span className="text-xs text-muted-foreground">
                {STATUS_WORDS[result.status]}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Preview({ summary }: { summary: TemplateSummary }) {
  const limit = describeDefaultLimit(summary.defaultBudget);
  return (
    <div
      className="mt-4 rounded-xl border bg-secondary/30 p-4 text-sm"
      data-testid="template-preview"
    >
      <h3 className="font-semibold">What you get</h3>
      <dl className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Channels and boards
          </dt>
          <dd>
            <ul className="mt-1 space-y-1">
              {summary.channels.map((channel) => (
                <li key={channel.name}>
                  <span className="font-medium">
                    {channel.board ? channel.name : `#${channel.name}`}
                  </span>
                  {channel.board ? (
                    <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-2xs font-medium">
                      {channel.private ? "Private board" : "Board"}
                    </span>
                  ) : null}
                  <span className="block text-xs text-muted-foreground">
                    {channel.purpose}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div className="space-y-3">
          {summary.helpers.length > 0 ? (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                AI helpers
              </dt>
              <dd className="mt-1">
                {summary.helpers.join(", ")}
                <span className="block text-xs text-muted-foreground">
                  Each starts as an open seat. Next you choose where each one
                  runs: in this browser, on the server, or on your computer.
                </span>
              </dd>
            </div>
          ) : null}
          {summary.pages.length > 0 ? (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Shared pages
              </dt>
              <dd className="mt-1">{summary.pages.join(", ")}</dd>
            </div>
          ) : null}
          {summary.automations.length > 0 ? (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Automations
              </dt>
              <dd className="mt-1">
                {summary.automations
                  .map((a) => a.replace(/-/g, " "))
                  .join(", ")}
              </dd>
            </div>
          ) : null}
          {limit ? (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                A limit for helpers
              </dt>
              <dd className="mt-1">{limit}</dd>
            </div>
          ) : null}
        </div>
      </dl>
      {summary.needsCommandLine.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          One extra skill ({summary.needsCommandLine.join(", ")}) is added from
          a web address, which only the command line can fetch. Everything else
          is set up here.
        </p>
      ) : null}
    </div>
  );
}

export function StartProject({
  onOpenChannel,
  onOpenView,
}: {
  /** Open a channel the project made. */
  onOpenChannel: (channelId: string) => void;
  /** Go to a part of the community. */
  onOpenView: (view: ProjectDestination) => void;
}) {
  const [choice, setChoice] = useState<string>(TEMPLATE_INDEX[0]?.id ?? "");
  const { state, apply, reset, access, refreshAccess } = useTemplateApply();
  const signedIn = existingUserPubkey() !== null;
  const summary = TEMPLATE_INDEX.find((t) => t.id === choice) ?? null;
  const busy = state.phase === "reading" || state.phase === "running";

  if (state.phase === "done") {
    const first = state.entry.template.channels[0];
    const firstId = first ? state.report.channelIds[first.id] : undefined;
    return (
      <Card className="m-3 p-5" data-testid="start-project-done">
        <h2 className="text-lg font-semibold">Your community is set up</h2>
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          {state.entry.template.name} is set up. There is a welcome message in #
          {first?.name ?? "the first channel"}.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {firstId ? (
            <Button
              data-testid="start-project-open-channel"
              onClick={() => onOpenChannel(firstId)}
            >
              Open #{first?.name}
            </Button>
          ) : null}
          {state.entry.template.personas.length > 0 ? (
            <Button
              data-testid="start-project-add-helper"
              onClick={() => onOpenView("agents")}
              variant="outline"
            >
              Choose where your AI helpers run
            </Button>
          ) : null}
          <Button onClick={() => onOpenView("org")} variant="outline">
            See your team
          </Button>
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            What was set up
          </summary>
          <div className="mt-2">
            <Progress busy={false} results={state.report.results} />
          </div>
        </details>
      </Card>
    );
  }

  if (state.phase === "stopped" || state.phase === "error") {
    const retryId = state.entry?.template.id;
    const stopped =
      state.phase === "stopped"
        ? state.report.results.find((r) => r.status === "failed")
        : null;
    return (
      <Card className="m-3 p-5" data-testid="start-project-problem">
        <h2 className="text-lg font-semibold">
          {state.phase === "stopped"
            ? "Setup did not finish"
            : "Setup needs attention"}
        </h2>
        <p
          className="mt-1 text-sm text-destructive"
          data-testid="start-project-problem-text"
          role="alert"
        >
          {stopped?.message ?? (state.phase === "error" ? state.message : "")}
        </p>
        {state.phase === "stopped" ? (
          <div className="mt-3">
            <Progress busy={false} results={state.report.results} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {retryId ? (
            <Button
              data-testid="start-project-retry"
              onClick={() => void apply(retryId)}
            >
              Try again
            </Button>
          ) : null}
          <Button onClick={reset} variant="outline">
            Back
          </Button>
        </div>
      </Card>
    );
  }

  if (busy) {
    return (
      <Card className="m-3 p-5" data-testid="start-project-running">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          Setting up {state.entry.template.name}
        </h2>
        <div className="mt-3">
          {state.phase === "running" ? (
            <Progress busy results={state.results} />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              Checking your permissions and what is already here…
            </p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="m-3 p-5" data-testid="start-project">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Users aria-hidden className="h-5 w-5" />
        Set up this community
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Add a ready-made team, AI helpers and shared pages to this community.
        Existing channels are reused. You can change anything afterwards.
      </p>
      {signedIn && access !== "allowed" ? (
        <div className="mt-3 text-sm" data-testid="start-project-access">
          <p role="status">
            {access === "checking"
              ? "Checking your community permissions…"
              : access === "denied"
                ? "Only this community's owner or an admin can set up its team. Ask one of them to do this."
                : access === "error"
                  ? "Couldn't check your community permissions. Check the connection, then try again."
                  : "Couldn't confirm your role in this community. Ask its owner or an admin, or check again."}
          </p>
          {access !== "checking" ? (
            <Button
              className="mt-2"
              data-testid="start-project-check-access"
              onClick={() => void refreshAccess()}
              variant="outline"
            >
              Check again
            </Button>
          ) : null}
        </div>
      ) : null}
      <fieldset className="mt-4">
        <legend className="sr-only">Choose a team</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEMPLATE_INDEX.map((template) => {
            const selected = template.id === choice;
            const audience = templateAudience(template.id);
            return (
              <label
                className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm ${
                  selected ? "border-primary bg-primary/5" : "border-border"
                } focus-within:ring-2 focus-within:ring-ring`}
                key={template.id}
              >
                <input
                  checked={selected}
                  className="sr-only"
                  data-testid={`template-option-${template.id}`}
                  name="template"
                  onChange={() => setChoice(template.id)}
                  type="radio"
                  value={template.id}
                />
                <span className="font-semibold">{templateTitle(template)}</span>
                {audience ? (
                  <span className="text-xs text-muted-foreground">
                    {audience}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {templateCounts(template)}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {summary ? (
        <>
          <p className="mt-4 text-sm text-muted-foreground">
            {summary.description}
          </p>
          <Preview summary={summary} />
        </>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {signedIn ? (
          <Button
            data-testid="start-project-confirm"
            disabled={!summary || access !== "allowed"}
            onClick={() => summary && void apply(summary.id)}
          >
            Set up community
          </Button>
        ) : (
          <>
            <Button
              data-testid="start-project-sign-up"
              onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
            >
              {CREATE_ACCOUNT}
            </Button>
            <span className="text-sm text-muted-foreground">
              to continue. Community setup needs an owner or admin account.
            </span>
          </>
        )}
      </div>
    </Card>
  );
}
