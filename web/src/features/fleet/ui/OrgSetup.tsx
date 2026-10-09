/**
 * Start your organization: three questions, then done.
 *
 * Shown on the Org page while the community has no organization yet. It asks what the organization is called, which
 * helper (agent) works for it, and how much a helper may do alone before it must ask. What each answer becomes is
 * decided in `../lib/org-setup.ts`; this file only asks and publishes.
 *
 * Publishing is several signed records, one after another. Each replaces the one before it with the same id, so a
 * failure part-way is safe to retry: the screen keeps what already went through, says which step stopped, and the same
 * button tries the rest.
 */

import { useState } from "react";
import { toast } from "sonner";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

import {
  AUTONOMY_LEVELS,
  type AutonomyId,
  emptyDraft,
  helperIssue,
  nameIssue,
  ORG_NAME_MAX,
  ORG_PURPOSE_MAX,
  type OrgSetupDraft,
  rejectionMessage,
  reviewLines,
  ROLE_NAME_MAX,
  type SetupRecord,
  setupRecords,
} from "../lib/org-setup";
import { type AgentCapabilities, useAgentRoster } from "../use-agent-roster";

type Step = "name" | "helper" | "limit" | "review";
const STEPS: { id: Step; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "helper", label: "Helper" },
  { id: "limit", label: "Limits" },
  { id: "review", label: "Start" },
];

async function publishRecord(record: SetupRecord): Promise<void> {
  const event = await signAsUser({
    kind: record.kind,
    content: record.content,
    tags: record.tags,
  });
  const result = await publishEvent(relayWsUrl(), event);
  if (!result.accepted) throw new Error(rejectionMessage(result.message));
}

export function OrgSetup({
  onStart,
  onFinish,
}: {
  /** Called when the first record goes out, so the page keeps this on screen even once a chart exists. */
  onStart?: () => void;
  /** Called once every record is published. */
  onFinish?: () => void;
}) {
  const { agents } = useAgentRoster();
  const [step, setStep] = useState<Step>("name");
  const [draft, setDraft] = useState<OrgSetupDraft>(emptyDraft);
  const [published, setPublished] = useState<ReadonlySet<SetupRecord["step"]>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const patch = (next: Partial<OrgSetupDraft>) =>
    setDraft((current) => ({ ...current, ...next }));
  const helperAgent: AgentCapabilities | undefined = agents.find(
    (agent) => agent.pubkey === draft.helper?.pubkey,
  );
  const issue =
    step === "name"
      ? nameIssue(draft)
      : step === "helper"
        ? helperIssue(draft)
        : null;
  // Do not scold an empty form: the first complaint comes with the first keystroke.
  const shownIssue = step === "name" && draft.name === "" ? null : issue;
  const index = STEPS.findIndex((entry) => entry.id === step);

  const create = async () => {
    setProblem(null);
    setBusy(true);
    onStart?.();
    try {
      const records = setupRecords(draft, userPubkey());
      const finished = new Set(published);
      for (const record of records) {
        if (finished.has(record.step)) continue;
        await publishRecord(record);
        finished.add(record.step);
        setPublished(new Set(finished));
      }
      setDone(true);
      onFinish?.();
      toast.success(`${draft.name.trim()} is ready.`);
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card className="p-5" data-testid="org-setup-done">
        <h2 className="text-lg font-semibold">{draft.name.trim()} is ready</h2>
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          Your organization now shows up below. Invite people to a channel, or
          open a project's page to give the team a treasury and a vote.
        </p>
      </Card>
    );
  }

  return (
    <Card className="m-3 p-5" data-testid="org-setup">
      <h2 className="text-lg font-semibold">Start your organization</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Four short steps. You can change any of it later.
      </p>
      <ol
        aria-label="Steps"
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      >
        {STEPS.map((entry, position) => (
          <li
            aria-current={position === index ? "step" : undefined}
            className={
              position === index
                ? "font-semibold"
                : position < index
                  ? "text-foreground/70"
                  : "text-muted-foreground"
            }
            key={entry.id}
          >
            {position + 1}. {entry.label}
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-col gap-3">
        {step === "name" ? (
          <>
            <div className="flex flex-col gap-1 text-sm font-medium">
              <label htmlFor="org-setup-name">
                What is your organization called?
              </label>
              <Input
                autoFocus
                id="org-setup-name"
                data-testid="org-setup-name"
                maxLength={ORG_NAME_MAX}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="Nebula Labs"
                value={draft.name}
              />
            </div>
            <div className="flex flex-col gap-1 text-sm font-medium">
              <label htmlFor="org-setup-purpose">
                What is it for?{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <Input
                id="org-setup-purpose"
                data-testid="org-setup-purpose"
                maxLength={ORG_PURPOSE_MAX}
                onChange={(event) => patch({ purpose: event.target.value })}
                placeholder="Maps the night sky, open source."
                value={draft.purpose}
              />
            </div>
          </>
        ) : null}

        {step === "helper" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              Who is the first helper?
            </legend>
            <p className="text-xs text-muted-foreground">
              A helper is an agent that does work for the team. Pick one that is
              already in this community, or add helpers later.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={draft.helper === null}
                data-testid="org-setup-helper-none"
                name="org-setup-helper"
                onChange={() => patch({ helper: null })}
                type="radio"
              />
              Add helpers later
            </label>
            {agents.map((agent) => (
              <label className="flex items-center gap-2 text-sm" key={agent.id}>
                <input
                  checked={draft.helper?.pubkey === agent.pubkey}
                  data-testid={`org-setup-helper-${agent.id}`}
                  name="org-setup-helper"
                  onChange={() =>
                    patch({
                      helper: {
                        pubkey: agent.pubkey,
                        role: draft.helper?.role ?? "",
                      },
                    })
                  }
                  type="radio"
                />
                <span>
                  {agent.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {agent.alive ? "online now" : "offline"}
                  </span>
                </span>
              </label>
            ))}
            {agents.length === 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="org-setup-no-helpers"
              >
                No helpers have joined this community yet.
              </p>
            ) : null}
            {draft.helper ? (
              <div className="flex flex-col gap-1 text-sm font-medium">
                <label htmlFor="org-setup-role">What do they do?</label>
                <Input
                  id="org-setup-role"
                  data-testid="org-setup-role"
                  maxLength={ROLE_NAME_MAX}
                  onChange={(event) =>
                    patch({
                      helper: {
                        pubkey: draft.helper?.pubkey ?? "",
                        role: event.target.value,
                      },
                    })
                  }
                  placeholder="Researcher"
                  value={draft.helper.role}
                />
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {step === "limit" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              How much can helpers do on their own?
            </legend>
            <p className="text-xs text-muted-foreground">
              Helpers ask you before going past the limit. You see the request
              and say yes or no. This never limits people.
            </p>
            {AUTONOMY_LEVELS.map((level) => (
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${draft.autonomy === level.id ? "border-primary bg-primary/5" : "border-border"}`}
                key={level.id}
              >
                <input
                  checked={draft.autonomy === level.id}
                  className="mt-1"
                  data-testid={`org-setup-autonomy-${level.id}`}
                  name="org-setup-autonomy"
                  onChange={() => patch({ autonomy: level.id as AutonomyId })}
                  type="radio"
                />
                <span>
                  <span className="block font-medium">{level.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {level.summary} {level.perDay.runs} runs,{" "}
                    {level.perDay.tasks} new tasks and {level.perDay.messages}{" "}
                    messages a day.
                  </span>
                </span>
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={draft.autonomy === null}
                data-testid="org-setup-autonomy-none"
                name="org-setup-autonomy"
                onChange={() => patch({ autonomy: null })}
                type="radio"
              />
              No limit for now
            </label>
          </fieldset>
        ) : null}

        {step === "review" ? (
          <div data-testid="org-setup-review">
            <h3 className="text-sm font-medium">Here is what will happen</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {reviewLines(draft, helperAgent ? helperAgent.name : null).map(
                (line) => (
                  <li key={line}>{line}</li>
                ),
              )}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Only this community's owner or an admin can start its
              organization. If that is not you, the server will say so and
              nothing is created.
            </p>
          </div>
        ) : null}

        {shownIssue ? (
          <p className="text-xs text-destructive" data-testid="org-setup-issue">
            {shownIssue}
          </p>
        ) : null}
        {problem ? (
          <p
            className="text-sm text-destructive"
            data-testid="org-setup-problem"
            role="alert"
          >
            {problem}
            {published.size > 0
              ? " Whatever already went through is kept; trying again carries on from there."
              : ""}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          {/* Once a record is out, the answers are fixed: changing the name now would leave the first team behind. */}
          {index > 0 && published.size === 0 ? (
            <Button
              data-testid="org-setup-back"
              disabled={busy}
              onClick={() => setStep(STEPS[index - 1].id)}
              type="button"
              variant="ghost"
            >
              Back
            </Button>
          ) : null}
          {step === "review" ? (
            <Button
              data-testid="org-setup-create"
              disabled={busy}
              onClick={create}
              type="button"
            >
              {busy
                ? "Starting…"
                : problem
                  ? "Try again"
                  : "Start the organization"}
            </Button>
          ) : (
            <Button
              data-testid="org-setup-next"
              disabled={issue !== null}
              onClick={() => setStep(STEPS[index + 1].id)}
              type="button"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
