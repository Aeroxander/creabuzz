/**
 * Fleet view — the live agent roster and the browser-agent launch control.
 *
 * Roster = live subscription over kind:44010 capabilities events (liveness
 * via heartbeat recency). Start/stop toggles the page's browser-hosted
 * agent, which announces itself, heartbeats, and answers mentions/tasks
 * through the relay's LLM gateway.
 */

import { useMemo, useState } from "react";
import {
  Bot,
  Cpu,
  Globe,
  HardDrive,
  Gauge,
  ListChecks,
  Play,
  Power,
  Wifi,
  WifiOff,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { useAgentTasks, type FleetTask } from "../use-agent-tasks";
import { helperSeats } from "../lib/helper-seats";
import { useLlmGateway } from "../use-llm-gateway";
import { useOrgChart } from "../use-org-chart";
import { useTabHelper } from "../use-tab-helper";
import { HelpersPanel } from "./HelpersPanel";
import { usageTotals, resetUsage } from "../agent-usage";

import { useAgentRoster, type AgentCapabilities } from "../use-agent-roster";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { relayWsUrl } from "@/shared/lib/relay-url";
import type { Channel } from "@/features/channels/use-channels";
import {
  peekAgentPubkey,
  resetAgentIdentity,
} from "@/shared/lib/agent-identity";
import { useUserNames } from "@/features/profiles/use-profiles";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { toast } from "sonner";

function RuntypeIcon({ runtype }: { runtype: AgentCapabilities["runtype"] }) {
  if (runtype === "browser") return <Globe className="h-3.5 w-3.5" />;
  if (runtype === "desktop") return <HardDrive className="h-3.5 w-3.5" />;
  return <Cpu className="h-3.5 w-3.5" />;
}

function AgentCard({ agent }: { agent: AgentCapabilities }) {
  // Author-based: an agent's `d` tag is chosen by whoever publishes it, so the
  // id alone does not establish that this row is this tab's agent.
  const me = agent.pubkey === peekAgentPubkey();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
      <div className="relative mt-0.5 shrink-0">
        <UserAvatar
          avatarUrl={null}
          displayName={agent.name}
          size="md"
          // Offline reads as desaturated, not transparent: half opacity halves
          // the contrast of the initials underneath, which axe flags as
          // serious (a name you cannot read is not a status).
          className={agent.alive ? "" : "grayscale"}
        />
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white dark:border-white/10 ${
            agent.alive
              ? "bg-emerald-500 text-white"
              : "bg-black/20 text-black/60 dark:bg-white/20 dark:text-white/60"
          }`}
        >
          <RuntypeIcon runtype={agent.runtype} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-black dark:text-white">
            {agent.name}
          </p>
          {me ? (
            <span className="rounded bg-black/5 px-1.5 py-0.5 text-2xs font-medium text-black/60 dark:bg-white/10 dark:text-white/60">
              this tab
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1 text-2xs text-black/60 dark:text-white/60">
            {agent.alive ? (
              <Wifi className="h-3 w-3 text-emerald-500" />
            ) : (
              <WifiOff className="h-3 w-3 text-black/60 dark:text-white/60" />
            )}
            {agent.alive ? "online" : "offline"}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-2xs text-black/60 dark:text-white/60">
          {agent.pubkey}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="capitalize">
            {agent.runtype}
          </Badge>
          <Badge
            variant={agent.status === "available" ? "default" : "secondary"}
            className="capitalize"
          >
            {agent.status}
          </Badge>
          {agent.tools.map((tool) => (
            <Badge key={tool} variant="outline">
              {tool}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function UsageCard() {
  const totals = usageTotals();
  return (
    <section
      className="rounded-lg border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-white/5"
      data-testid="usage-card"
    >
      <div className="flex items-center gap-2">
        <Gauge className="h-3.5 w-3.5 text-black/60 dark:text-white/60" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          This tab's helper · usage
        </h3>
        <span className="ml-auto text-xs text-black/60 dark:text-white/60">
          ~${totals.est.toFixed(3)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-black/[0.03] p-1.5 dark:bg-white/5">
          <p className="text-sm font-semibold text-black dark:text-white">
            {totals.calls}
          </p>
          <p className="text-2xs text-black/60 dark:text-white/60">calls</p>
        </div>
        <div className="rounded-md bg-black/[0.03] p-1.5 dark:bg-white/5">
          <p className="text-sm font-semibold text-black dark:text-white">
            {totals.prompt.toLocaleString()}
          </p>
          <p className="text-2xs text-black/60 dark:text-white/60">tokens in</p>
        </div>
        <div className="rounded-md bg-black/[0.03] p-1.5 dark:bg-white/5">
          <p className="text-sm font-semibold text-black dark:text-white">
            {totals.completion.toLocaleString()}
          </p>
          <p className="text-2xs text-black/60 dark:text-white/60">
            tokens out
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => resetUsage()}
        className="mt-1.5 text-2xs text-black/60 hover:text-black/70 dark:text-white/60 dark:hover:text-white/70"
      >
        Reset counts
      </button>
    </section>
  );
}

const STATUS_VARIANT: Record<
  FleetTask["status"],
  "default" | "secondary" | "outline"
> = {
  open: "outline",
  assigned: "outline",
  in_progress: "secondary",
  needs_approval: "secondary",
  done: "default",
  cancelled: "outline",
};

function TaskCard({ task }: { task: FleetTask }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-black dark:text-white">
          {task.title}
        </p>
        <p className="mt-0.5 truncate font-mono text-2xs text-black/60 dark:text-white/60">
          {task.id}
        </p>
      </div>
      <Badge
        variant={STATUS_VARIANT[task.status]}
        className="shrink-0 capitalize"
      >
        {task.status.replace("_", " ")}
      </Badge>
    </div>
  );
}

/**
 * The task list and the "assign a task" form. It owns the task read, so the
 * parent retries a failed read by remounting it (a new `key`).
 */
function TasksSection({
  agents,
  channelIds,
  onRetry,
}: {
  agents: AgentCapabilities[];
  channelIds: readonly string[];
  onRetry: () => void;
}) {
  const {
    tasks,
    createTask,
    loadError: taskLoadError,
  } = useAgentTasks(channelIds);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [creating, setCreating] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center gap-2">
        <ListChecks className="h-3.5 w-3.5 text-black/60 dark:text-white/60" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Tasks
        </h3>
        <span className="ml-auto text-xs text-black/60 dark:text-white/60">
          {tasks.length}
        </span>
      </div>
      {taskLoadError && tasks.length === 0 ? (
        <QueryError
          description="The server did not answer, so the tasks can't be shown."
          error={taskLoadError}
          message={errorMessage(taskLoadError)}
          onRetry={onRetry}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="fleet-tasks-load-error"
          title="Couldn't load tasks"
        />
      ) : null}
      <div className="mt-2 flex gap-2">
        <input
          value={taskTitle}
          onChange={(e) => setTaskTitle(e.target.value)}
          placeholder="Assign a task…"
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none placeholder:text-black/60 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:placeholder:text-white/40"
          data-testid="task-title-input"
        />
        <select
          aria-label="Assign the task to"
          value={taskAssignee}
          onChange={(e) => setTaskAssignee(e.target.value)}
          className="w-32 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
          data-testid="task-assignee-select"
        >
          <option value="">Anyone</option>
          {agents.map((a) => (
            <option key={a.pubkey} value={a.pubkey}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={creating || taskTitle.trim().length === 0}
          onClick={() => {
            setCreating(true);
            setTaskError(null);
            void createTask({
              title: taskTitle.trim(),
              assignee: taskAssignee || undefined,
            })
              .catch((e) =>
                setTaskError(e instanceof Error ? e.message : "task failed"),
              )
              .finally(() => {
                setCreating(false);
                setTaskTitle("");
              });
          }}
          className="rounded-md bg-black px-2.5 py-1.5 text-xs font-medium text-white hover:bg-black/80 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-white/80"
          data-testid="task-create"
        >
          Create
        </button>
      </div>
      {taskError ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {taskError}
        </p>
      ) : null}
      {tasks.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {tasks.slice(0, 12).map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function FleetView({ channels }: { channels: Channel[] }) {
  const { agents, loading, loadError, reload } = useAgentRoster();
  const channelIds = useMemo(() => channels.map((c) => c.id), [channels]);
  /** Bumped by the tasks panel's Retry: remounting it re-runs the task read. */
  const [tasksEpoch, setTasksEpoch] = useState(0);
  const tab = useTabHelper(channels);
  const { state, error, starting } = tab;
  const gateway = useLlmGateway();
  const { byKey: orgNodes } = useOrgChart();
  const seats = useMemo(() => helperSeats(orgNodes), [orgNodes]);
  const [confirmReset, setConfirmReset] = useState(false);

  // The tab agent is a person like any other fleet member: resolve its own
  // pubkey through the same batched profile read before naming it.
  const tabAgentPubkey = peekAgentPubkey();
  const tabAgentPubkeys = useMemo(
    () => (tabAgentPubkey ? [tabAgentPubkey] : []),
    [tabAgentPubkey],
  );
  const userName = useUserNames(tabAgentPubkeys);

  if (loadError && agents.length === 0) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col p-4">
        <PageHeader title="AI helpers" />
        <QueryError
          description="The server didn't answer, so the AI helpers can't be listed."
          error={loadError}
          message={errorMessage(loadError)}
          onRetry={reload}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="fleet-load-error"
          title="Couldn't load AI helpers"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 p-4">
      <PageHeader
        title="AI helpers"
        action={
          <div className="flex items-center gap-3">
            <span className="text-xs text-black/60 dark:text-white/60">
              {agents.filter((a) => a.alive).length} online · {agents.length}{" "}
              total
            </span>
            <button
              type="button"
              onClick={() =>
                state === "running" ? tab.stop() : void tab.start(null)
              }
              disabled={starting}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${
                state === "running"
                  ? "border border-black/15 bg-white text-black hover:bg-black/5 dark:border-white/15 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
                  : "bg-black text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
              }`}
              data-testid="browser-agent-toggle"
            >
              {state === "running" ? (
                <Power className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {state === "running"
                ? "Stop tab helper"
                : starting
                  ? "Starting…"
                  : "Run in this tab"}
            </button>
          </div>
        }
      />

      {error ? (
        <p className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <HelpersPanel agents={agents} gateway={gateway} seats={seats} tab={tab} />

      {state === "running" ? (
        <p className="rounded-md border border-black/10 bg-white px-3 py-2 text-xs text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
          {tab.persona ? (
            <>
              <strong>{tab.persona.name}</strong> is <strong>online</strong>.
              Mention{" "}
              <code className="rounded bg-black/5 px-1 py-0.5 font-mono dark:bg-white/10">
                @{tab.persona.name}
              </code>{" "}
              in a channel to get an answer.
            </>
          ) : (
            <>
              This tab's helper is <strong>online</strong> as{" "}
              <strong>{userName(tabAgentPubkey ?? "")}</strong>. Mention{" "}
              <code className="rounded bg-black/5 px-1 py-0.5 font-mono dark:bg-white/10">
                @buzz-tab
              </code>{" "}
              in a channel to get a response.
            </>
          )}
        </p>
      ) : null}

      {state === "running" ? <UsageCard /> : null}

      <p
        className="text-xs text-black/60 dark:text-white/60"
        data-testid="agent-key-disclosure"
      >
        {state === "running"
          ? "This helper's account lives in this browser. Stop it first to remove it."
          : "A helper you start here gets its own account in this browser."}
      </p>
      {/* Only when this browser holds a helper account: with none, there is nothing to remove. */}
      {state !== "running" && tabAgentPubkey ? (
        <details className="text-xs text-black/60 dark:text-white/60">
          <summary className="cursor-pointer font-medium">
            Remove this tab's helper account
          </summary>
          <div className="mt-2">
            <button
              className="rounded-md border border-black/15 px-2.5 py-1.5 text-xs font-medium dark:border-white/15"
              data-testid="reset-agent-key"
              onClick={() => setConfirmReset(true)}
              type="button"
            >
              Remove helper account
            </button>
          </div>
        </details>
      ) : null}

      <ConfirmDialog
        confirmLabel="Remove helper account"
        description="The next helper you start here gets a new account. What the old one did stays under its name."
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          resetAgentIdentity();
          toast.success("Helper account removed");
        }}
        open={confirmReset}
        title="Remove this tab's helper account?"
      />

      <TasksSection
        agents={agents}
        channelIds={channelIds}
        key={tasksEpoch}
        onRetry={() => setTasksEpoch((n) => n + 1)}
      />

      <section
        aria-label="Helpers"
        className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this scroll container to scroll it.
        tabIndex={0}
      >
        {loading && agents.length === 0 ? (
          <p className="text-xs text-black/60 dark:text-white/60">
            Loading roster…
          </p>
        ) : agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-black/60 dark:border-white/15 dark:text-white/60">
            <Bot className="mx-auto mb-2 h-8 w-8 text-black/60 dark:text-white/60" />
            No helpers have announced themselves yet. Start one above and it
            shows up here.
          </div>
        ) : (
          agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)
        )}
      </section>
    </div>
  );
}
