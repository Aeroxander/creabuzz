/**
 * Work board — one view over everything being worked on (tasks + git issues).
 *
 * Style follows the desktop-aligned pass: floating surfaces over the wash,
 * pill filters, UserAvatar identities, status badges.
 */

import { useEffect, useMemo, useState } from "react";
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
import type { Channel } from "@/features/channels/use-channels";
import { userPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { UserAvatar } from "@/shared/ui/UserAvatar";
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
}: {
  item: WorkItem;
  selected: boolean;
  onSelect: () => void;
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
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
      ) : (
        <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-black dark:text-white">
          {item.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-black/45 dark:text-white/45">
          <Badge
            variant={statusVariant(item.status)}
            className="px-1.5 py-0 text-[10px]"
          >
            {STATUS_LABEL[item.status] ?? item.status}
          </Badge>
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] capitalize"
          >
            {item.type}
          </Badge>
          <span className="truncate font-mono">
            {item.scopeLabel === "repo" && item.scope
              ? `repo ${item.scope.slice(0, 12)}`
              : item.assignee
                ? truncatePubkey(item.assignee)
                : "unassigned"}
          </span>
        </span>
      </span>
      {item.assignee ? (
        <UserAvatar
          avatarUrl={null}
          displayName={item.assignee}
          size="xs"
          className="shrink-0"
        />
      ) : null}
    </button>
  );
}

export function WorkBoard({ channels }: { channels: Channel[] }) {
  const { items, loading, createTask, requestApproval, approve, reject } =
    useWorkBoard();
  const { agents } = useAgentRoster();
  const [filter, setFilter] = useState<"all" | "mine" | "open" | "done">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "task" | "issue">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [channelId, setChannelId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const myPubkey = userPubkey();
  const selected = items.find((i) => i.id === selectedId) ?? null;

  const canReplyToThread =
    selected?.type === "task" && !!selected.scope && !!selected.parentEventId;

  const sendThreadReply = () => {
    if (!selected || !canReplyToThread || reply.trim().length === 0) return;
    setSendingReply(true);
    setReplyError(null);
    void (async () => {
      try {
        const signed = await signAsUser({
          kind: 9,
          tags: [
            ["h", selected.scope!],
            ["e", selected.parentEventId!],
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

  const submit = () => {
    if (title.trim().length === 0) return;
    setCreating(true);
    void createTask({
      title: title.trim(),
      assignee: assignee || undefined,
      channelId: channelId || undefined,
    })
      .then(() => setTitle(""))
      .finally(() => setCreating(false));
  };

  const asTask = (item: WorkItem): FleetTask => {
    const task = parseTask({
      id: item.id,
      pubkey: item.author,
      kind: 44011,
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 p-4">
      <PageHeader
        title="Work"
        action={
          <span className="text-xs text-black/45 dark:text-white/45">
            {items.length} items ·{" "}
            {items.filter((i) => i.type === "task").length} tasks ·{" "}
            {items.filter((i) => i.type === "issue").length} issues
          </span>
        }
      />

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
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none placeholder:text-black/40 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:placeholder:text-white/40"
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
          {loading && filtered.length === 0 ? (
            <p className="text-xs text-black/45 dark:text-white/45">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
              No work items match.
            </p>
          ) : (
            filtered.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onSelect={() => setSelectedId(item.id)}
              />
            ))
          )}
        </div>

        <div className="flex min-h-0 flex-col overflow-y-auto rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
          {selected ? (
            <>
              <div className="flex items-start gap-2">
                {selected.type === "task" ? (
                  <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
                ) : (
                  <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
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
                    <span className="text-[11px] text-black/45 dark:text-white/45">
                      by {truncatePubkey(selected.author)}
                    </span>
                  </div>
                </div>
              </div>

              <p className="mt-2 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">
                {selected.description || "No description."}
              </p>

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
                      <span className="text-[11px] text-black/45 dark:text-white/45">
                        resolved by {truncatePubkey(selected.approver)}
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
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                  <ListChecks className="h-3 w-3" /> Thread
                </h4>
                {selected.parentEventId ? (
                  <RecentThread parentId={selected.parentEventId} />
                ) : (
                  <p className="text-xs text-black/40 dark:text-white/40">
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
                    className="min-w-0 flex-1 resize-none rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none placeholder:text-black/40 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:placeholder:text-white/40"
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
              <p className="text-sm text-black/50 dark:text-white/50">
                Select a work item to see its thread and actions.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RecentThread({
  parentId,
  entryVersion,
}: {
  parentId: string;
  entryVersion: number;
}) {
  const [rows, setRows] = useState<
    { author: string; content: string; created: number }[]
  >([]);
  useEffect(() => {
    let disposed = false;
    const load = () =>
      void import("@/shared/lib/http-query").then(({ queryEventsHttp }) =>
        queryEventsHttp([
          {
            kinds: [9, 40002, 44011],
            "#e": [parentId],
            limit: 50,
          },
        ])
          .then((events) => {
            if (disposed) return;
            setRows(
              events
                .sort((a, b) => a.created_at - b.created_at)
                .map((e) => ({
                  author: e.pubkey,
                  content: e.content.slice(0, 400),
                  created: e.created_at,
                })),
            );
          })
          .catch(() => {}),
      );
    load();
    // Live-ish: refresh while the pane is open so agent replies land.
    const timer = setInterval(load, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [parentId]);

  return (
    <div className="flex flex-col gap-1.5">
      {rows.length === 0 ? (
        <p className="text-xs text-black/40 dark:text-white/40">
          Loading thread…
        </p>
      ) : (
        rows.map((row) => (
          <div
            key={row.author + "-" + row.created}
            className="flex items-start gap-2 rounded-md bg-black/[0.03] p-2 dark:bg-white/5"
          >
            <UserAvatar
              avatarUrl={null}
              displayName={row.author}
              size="xs"
              className="mt-0.5"
            />
            <div className="min-w-0">
              <p className="truncate text-[10px] font-medium text-black/45 dark:text-white/45">
                {truncatePubkey(row.author)}
              </p>
              <p className="whitespace-pre-wrap break-words text-xs text-black/80 dark:text-white/80">
                {row.content}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
