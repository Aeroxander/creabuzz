/**
 * Work board — one view over everything being worked on (tasks + git issues).
 *
 * Style follows the desktop-aligned pass: floating surfaces over the wash,
 * pill filters, UserAvatar identities, status badges.
 */

import { useMemo, useState } from "react";
import {
  Check,
  CircleDot,
  GitPullRequest,
  ListChecks,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";

import { useAgentRoster } from "../use-agent-roster";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";
import { ArrowUp } from "lucide-react";
import { useWorkBoard, type WorkItem } from "../use-work-board";
import { useTaskPlanning } from "../use-task-planning";
import { NextUpList } from "./NextUpList";
import { TaskPlanningPanel } from "./TaskPlanningPanel";
import { KanbanBoard, ISSUE_MOVE_TARGETS } from "./KanbanBoard";
import { RecentThread, TaskHistory } from "./WorkBoardThread";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { useUserNames } from "@/features/profiles/use-profiles";
import { KIND_AGENT_TASK, KIND_STREAM_MESSAGE } from "@/shared/constants/kinds";
import type { TaskPriority } from "../use-agent-tasks";
import type { Channel } from "@/features/channels/use-channels";
import { userPubkey } from "@/shared/lib/identity";
import { Badge } from "@/shared/ui/badge";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { toast } from "sonner";
import { PageHeader } from "@/shared/ui/PageHeader";
import { parseTask, type FleetTask } from "../use-agent-tasks";

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  triage: "Triage",
  needs_approval: "Approval",
  done: "Done",
  closed: "Closed",
  cancelled: "Cancelled",
};

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "done") return "default";
  if (status === "in_progress" || status === "assigned") return "secondary";
  return "outline";
}

function WorkItemRow({
  item,
  selected,
  onSelect,
  userName,
}: {
  item: WorkItem;
  selected: boolean;
  onSelect: () => void;
  userName: (pubkey: string) => string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-black/25 bg-black/5 dark:border-white/25 dark:bg-white/10"
          : "border-black/10 bg-white hover:bg-black/[0.02] dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
      }`}
    >
      {item.type === "task" ? (
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
      ) : (
        <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-black dark:text-white">
          {item.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-black/60 dark:text-white/60">
          <Badge
            variant={statusVariant(item.status)}
            className="px-1.5 py-0 text-2xs"
          >
            {STATUS_LABEL[item.status] ?? item.status}
          </Badge>
          <Badge variant="outline" className="px-1.5 py-0 text-2xs capitalize">
            {item.type}
          </Badge>
          <span className="truncate font-mono">
            {item.scopeLabel === "repo" && item.scope
              ? `repo ${item.scope.slice(0, 12)}`
              : item.assignee
                ? userName(item.assignee)
                : "unassigned"}
          </span>
        </span>
      </span>
      {item.assignee ? (
        <UserAvatar
          avatarUrl={null}
          displayName={userName(item.assignee)}
          size="xs"
          className="shrink-0"
        />
      ) : null}
    </button>
  );
}

/**
 * A failed board action must not look like it worked: a column move, an
 * assignment or a task edit that the relay refused used to leave only a console
 * line behind.
 */
function reportActionFailure(what: string) {
  return (error: unknown) => {
    console.error(`[work] ${what}`, error);
    toast.error(what, { description: errorMessage(error) });
  };
}

export function WorkBoard({
  channels,
  initialItemId,
  onSelectItem,
}: {
  channels: Channel[];
  /** Work item from the URL, so a task can be linked to. */
  initialItemId?: string;
  /** Reports the selected item, for the URL. */
  onSelectItem?: (id: string | null) => void;
}) {
  const {
    items,
    loading,
    loadError,
    degraded,
    reload,
    createTask,
    requestApproval,
    approve,
    reject,
    setStatus,
    publishIssueStatus,
    setAssignee: setTaskAssignee,
    updateTask,
  } = useWorkBoard(channels);
  const planning = useTaskPlanning(items);
  const { agents } = useAgentRoster();
  const [filter, setFilter] = useState<"all" | "mine" | "open" | "done">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "task" | "issue">("all");
  const [view, setView] = useState<"list" | "board" | "next">("board");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialItemId ?? null,
  );

  /** Selection is addressable: the detail pane can be linked to. */
  const selectItem = (id: string | null) => {
    setSelectedId(id);
    onSelectItem?.(id);
  };
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [due, setDue] = useState("");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [channelId, setChannelId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const myPubkey = userPubkey();
  const selected = items.find((i) => i.key === selectedId) ?? null;

  const canReplyToThread =
    selected?.type === "task" && !!selected.scope && !!selected.parentEventId;

  const sendThreadReply = () => {
    // Bind the two ids the reply depends on rather than asserting them later:
    // the assertion would outlive the guard if the selection changed.
    const scope = selected?.scope;
    const parentEventId = selected?.parentEventId;
    if (!scope || !parentEventId || reply.trim().length === 0) return;
    setSendingReply(true);
    setReplyError(null);
    void (async () => {
      try {
        const signed = await signAsUser({
          kind: KIND_STREAM_MESSAGE,
          tags: [
            ["h", scope],
            ["e", parentEventId],
          ],
          content: reply.trim(),
        });
        const result = await publishEvent(relayWsUrl(), signed, {
          signAuth: signAsUser,
        });
        if (!result.accepted) {
          throw new Error(result.message ?? "reply rejected");
        }
        setReply("");
      } catch (error) {
        setReplyError(error instanceof Error ? error.message : "reply failed");
      } finally {
        setSendingReply(false);
      }
    })();
  };
  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (filter === "mine" && item.assignee !== myPubkey) return false;
      if (
        filter === "open" &&
        ![
          "open",
          "assigned",
          "in_progress",
          "triage",
          "needs_approval",
        ].includes(item.status)
      )
        return false;
      if (
        filter === "done" &&
        !["done", "closed", "cancelled"].includes(item.status)
      )
        return false;
      return true;
    });
  }, [items, filter, typeFilter, myPubkey]);

  // Every person this surface labels — the assignees on the board plus the
  // author and approver of the open item — in one batched kind-0 read.
  const personPubkeys = useMemo(() => {
    const pubkeys = new Set<string>();
    for (const item of filtered) {
      if (item.assignee) pubkeys.add(item.assignee);
    }
    if (selected?.author) pubkeys.add(selected.author);
    if (selected?.approver) pubkeys.add(selected.approver);
    return [...pubkeys];
  }, [filtered, selected]);
  const userName = useUserNames(personPubkeys);

  const submit = () => {
    if (title.trim().length === 0) return;
    setCreating(true);
    void createTask({
      title: title.trim(),
      assignee: assignee || undefined,
      channelId: channelId || undefined,
      priority,
      due: due ? Math.floor(new Date(due).getTime() / 1000) : null,
    })
      .then(() => setTitle(""))
      .finally(() => setCreating(false));
  };

  const asTask = (item: WorkItem): FleetTask => {
    const task = parseTask({
      id: item.id,
      pubkey: item.author,
      kind: KIND_AGENT_TASK,
      created_at: Math.floor(item.updatedAt / 1000),
      tags: [
        ["d", item.id],
        ...(item.assignee ? [["p", item.assignee] as string[]] : []),
        ...(item.scope ? [["h", item.scope] as string[]] : []),
        ...(item.parentEventId ? [["e", item.parentEventId] as string[]] : []),
      ],
      content: JSON.stringify({
        title: item.title,
        description: item.description,
        status: item.status,
        priority: item.priority ?? "normal",
        due: item.due ?? null,
        labels: item.labels ?? [],
        // Round-trip every planning field: a row published from this task
        // writes them all, and a missing one would publish as a clear.
        milestone: item.milestone,
        reward: item.reward,
      }),
      sig: "",
    });
    if (!task) throw new Error("invalid work item");
    return task;
  };

  const Pill = ({
    active,
    label,
    onClick,
  }: {
    active: boolean;
    label: string;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-black text-white dark:bg-white dark:text-black"
          : "border border-black/10 bg-white text-black/70 hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
      }`}
    >
      {label}
    </button>
  );

  if (loadError && items.length === 0) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col p-4">
        <PageHeader title="Work" />
        <QueryError
          description="The relay did not answer the task and issue query, so this board has nothing to show."
          message={errorMessage(loadError)}
          onRetry={reload}
          testId="work-load-error"
          title="Couldn't load the work board"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
      <PageHeader
        title="Work"
        action={
          <span className="text-xs text-black/60 dark:text-white/60">
            {items.length} items ·{" "}
            {items.filter((i) => i.type === "task").length} tasks ·{" "}
            {items.filter((i) => i.type === "issue").length} issues
          </span>
        }
      />

      {degraded ? (
        <p
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300"
          data-testid="work-degraded"
        >
          Status and approval history could not be loaded, so some items show
          their default column. ({degraded})
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "mine", "open", "done"] as const).map((f) => (
          <Pill
            key={f}
            active={filter === f}
            label={
              f === "all"
                ? "All"
                : f === "mine"
                  ? "Mine"
                  : f === "open"
                    ? "Open"
                    : "Done"
            }
            onClick={() => setFilter(f)}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" />
        {(["all", "task", "issue"] as const).map((t) => (
          <Pill
            key={t}
            active={typeFilter === t}
            label={
              t === "all" ? "All types" : t === "task" ? "Tasks" : "Issues"
            }
            onClick={() => setTypeFilter(t)}
          />
        ))}
      </div>

      {/* create */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-white/5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task…"
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none placeholder:text-black/60 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:placeholder:text-white/40"
          data-testid="work-create-input"
        />
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="w-28 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
          aria-label="Channel"
        >
          <option value="">No channel</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="w-28 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
          aria-label="Assignee"
        >
          <option value="">Anyone</option>
          {agents.map((a) => (
            <option key={a.pubkey} value={a.pubkey}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          className="w-24 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
          aria-label="Priority"
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Due date"
          className="w-32 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none dark:border-white/10 dark:bg-white/5"
        />
        <button
          type="button"
          disabled={creating || title.trim().length === 0}
          onClick={submit}
          className="rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="work-create"
        >
          Create
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {(["board", "list", "next"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              view === v
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "border border-black/10 bg-white text-black/70 hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
            }`}
            data-testid={`work-view-${v}`}
          >
            {v === "board" ? "Board" : v === "list" ? "List" : "Next up"}
          </button>
        ))}
      </div>

      {view === "board" ? (
        <KanbanBoard
          items={filtered}
          onSetStatus={(item, status) => {
            if (item.type === "issue") {
              if (ISSUE_MOVE_TARGETS.includes(status)) {
                void publishIssueStatus(item, status).catch(
                  reportActionFailure("Couldn't move this issue"),
                );
              }
              return;
            }
            void setStatus(asTask(item), status).catch(
              reportActionFailure("Couldn't move this task"),
            );
          }}
          onAssignSelf={(item) => {
            if (item.type === "task") {
              void setTaskAssignee(asTask(item), myPubkey).catch(
                reportActionFailure("Couldn't assign this task"),
              );
            }
          }}
          onUnassign={(item) => {
            if (item.type === "task") {
              void setTaskAssignee(asTask(item), null).catch(
                reportActionFailure("Couldn't unassign this task"),
              );
            }
          }}
          onQuickAdd={(_status, taskTitle) => {
            void createTask({ title: taskTitle }).catch(
              reportActionFailure("Couldn't create the task"),
            );
          }}
        />
      ) : view === "next" ? (
        <NextUpList
          items={items}
          planning={planning}
          onOpen={(item) => {
            selectItem(item.key);
            setView("list");
          }}
        />
      ) : (
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-2">
          <div className="flex min-h-0 min-w-0 flex-col gap-1.5 overflow-y-auto pr-1">
            {loading && filtered.length === 0 ? (
              <p className="text-xs text-black/60 dark:text-white/60">
                Loading…
              </p>
            ) : filtered.length === 0 ? (
              <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-black/60 dark:border-white/15 dark:text-white/60">
                No work items match.
              </p>
            ) : (
              filtered.map((item) => (
                <WorkItemRow
                  key={item.key}
                  item={item}
                  selected={selectedId === item.key}
                  onSelect={() => selectItem(item.key)}
                  userName={userName}
                />
              ))
            )}
          </div>

          <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
            {selected ? (
              <>
                <div className="flex items-start gap-2">
                  {selected.type === "task" ? (
                    <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
                  ) : (
                    <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-black dark:text-white">
                      {selected.title}
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={statusVariant(selected.status)}
                        className="capitalize"
                      >
                        {STATUS_LABEL[selected.status] ?? selected.status}
                      </Badge>
                      <Badge variant="outline" className="capitalize">
                        {selected.type}
                      </Badge>
                      <span className="text-2xs text-black/60 dark:text-white/60">
                        by {userName(selected.author)}
                      </span>
                    </div>
                  </div>
                </div>

                <p className="mt-2 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">
                  {selected.description || "No description."}
                </p>

                {selected.type === "task" ? (
                  <TaskEditors
                    item={selected}
                    onUpdate={(patch) =>
                      void updateTask(asTask(selected), patch).catch(
                        reportActionFailure("Couldn't save the task"),
                      )
                    }
                  />
                ) : null}

                {selected.type === "task" ? (
                  <TaskPlanningPanel
                    key={selected.key}
                    item={selected}
                    planning={planning}
                    onUpdate={(patch) => updateTask(asTask(selected), patch)}
                  />
                ) : null}

                {selected.type === "task" &&
                  selected.status === "needs_approval" && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy === selected.id}
                        onClick={() => {
                          setBusy(selected.id);
                          void approve(asTask(selected)).finally(() =>
                            setBusy(null),
                          );
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy === selected.id}
                        onClick={() => {
                          setBusy(selected.id);
                          void reject(asTask(selected)).finally(() =>
                            setBusy(null),
                          );
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-black/15 bg-white px-3 py-1.5 text-xs font-medium text-black/70 hover:bg-black/5 dark:border-white/15 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
                      >
                        <ShieldX className="h-3.5 w-3.5" /> Reject
                      </button>
                      {selected.approver ? (
                        <span className="text-2xs text-black/60 dark:text-white/60">
                          resolved by {userName(selected.approver)}
                        </span>
                      ) : null}
                    </div>
                  )}

                {selected.type === "task" &&
                  (selected.status === "open" ||
                    selected.status === "assigned" ||
                    selected.status === "in_progress") &&
                  selected.author === myPubkey && (
                    <div className="mt-3">
                      <button
                        type="button"
                        disabled={busy === selected.id}
                        onClick={() => {
                          setBusy(selected.id);
                          void requestApproval(asTask(selected)).finally(() =>
                            setBusy(null),
                          );
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-black/15 bg-white px-3 py-1.5 text-xs font-medium text-black/70 hover:bg-black/5 dark:border-white/15 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
                      >
                        <Check className="h-3.5 w-3.5" /> Request approval
                      </button>
                    </div>
                  )}

                <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
                  <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
                    <ListChecks className="h-3 w-3" /> Thread
                  </h4>
                  {selected.parentEventId ? (
                    <RecentThread parentId={selected.parentEventId} />
                  ) : (
                    <p className="text-xs text-black/60 dark:text-white/60">
                      No linked thread
                      {selected.type === "issue"
                        ? " (issues live in Projects)"
                        : " — assign from chat with @agent:"}
                      .
                    </p>
                  )}
                </div>

                {canReplyToThread ? (
                  <div className="mt-2 flex items-end gap-2 border-t border-black/10 pt-2 dark:border-white/10">
                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={2}
                      placeholder={"Ask @buzz-tab in this thread…"}
                      className="min-w-0 flex-1 resize-none rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none placeholder:text-black/60 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:placeholder:text-white/40"
                      data-testid="thread-reply-input"
                    />
                    <button
                      type="button"
                      disabled={sendingReply || reply.trim().length === 0}
                      onClick={sendThreadReply}
                      aria-label="Reply in thread"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black text-white disabled:opacity-30 dark:bg-white dark:text-black"
                      data-testid="thread-reply-send"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
                {replyError ? (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {replyError}
                  </p>
                ) : null}
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <X className="mb-2 h-6 w-6 text-black/20 dark:text-white/20" />
                <p className="text-sm text-black/60 dark:text-white/60">
                  Select a work item to see its thread and actions.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline editors for task planning fields (description, priority, due,
 * labels). Always relevant for tasks; updates publish a new LWW row.
 */
function TaskEditors({
  item,
  onUpdate,
}: {
  item: WorkItem;
  onUpdate: (patch: {
    description?: string;
    priority?: TaskPriority;
    due?: number | null;
    labels?: string[];
  }) => void;
}) {
  const [desc, setDesc] = useState(item.description);
  const [priority, setPriority] = useState<TaskPriority>(
    item.priority ?? "normal",
  );
  const [due, setDue] = useState(
    item.due ? new Date(item.due * 1000).toISOString().slice(0, 10) : "",
  );
  const [labels, setLabels] = useState((item.labels ?? []).join(", "));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = () => {
    onUpdate({
      description: desc,
      priority,
      due: due ? Math.floor(new Date(due).getTime() / 1000) : null,
      labels: labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    });
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-black/10 bg-black/[0.02] p-2.5 dark:border-white/10 dark:bg-white/5">
      <textarea
        value={desc}
        onChange={(e) => {
          setDesc(e.target.value);
          setDirty(true);
        }}
        rows={3}
        placeholder="Description…"
        className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        data-testid="task-desc-input"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value as TaskPriority);
            setDirty(true);
          }}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none"
          aria-label="Edit priority"
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
        <input
          type="date"
          value={due}
          onChange={(e) => {
            setDue(e.target.value);
            setDirty(true);
          }}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none"
          aria-label="Edit due date"
        />
        <input
          value={labels}
          onChange={(e) => {
            setLabels(e.target.value);
            setDirty(true);
          }}
          placeholder="Labels (comma-separated)"
          className="w-40 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none"
          aria-label="Edit labels"
        />
        <button
          type="button"
          disabled={!dirty}
          onClick={save}
          className="ml-auto rounded-full bg-black px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="task-fields-save"
        >
          {saved ? "Saved ✓" : "Save fields"}
        </button>
      </div>
      <TaskHistory taskId={item.id} />
    </div>
  );
}
