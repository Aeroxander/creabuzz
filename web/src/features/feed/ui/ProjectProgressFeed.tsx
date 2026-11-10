import { Link, useRouterState } from "@tanstack/react-router";
import { Link as LinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLaunches } from "@/features/launchpad/use-launches";
import type { Launch, LaunchUpdate } from "@/features/launchpad/models";
import { daoOfLaunch } from "@/features/launchpad/lib/dao-of-launch";
import { isIdea } from "@/features/launchpad/lib/idea";
import { UpdateBody } from "@/features/launchpad/ui/UpdateBody";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { projectProgress, progressArtifacts } from "../lib/project-progress";
import type { SignedEventLike } from "../lib/feed-events";
import { followedLaunches } from "../lib/lists";
import { useFeedNotes, useMyLists, useVoteTallies } from "../use-feed";
import { progressScope, useProgressSeen } from "../use-progress-seen";
import { EMPTY_TALLY } from "../lib/ranking";
import { VoteButtons } from "./VoteButtons";
import { Chip } from "@/shared/ui/chip";

/** Public project reports and evidence. Private task/agent activity is never copied into this feed. */
export function ProjectProgressFeed({
  project,
  compact = false,
  posts,
}: {
  project?: Launch;
  compact?: boolean;
  /**
   * The posts marked as this project's updates, read for the project on its own. When given they are used in place of
   * the home feed's posts, which are a cut of everyone's and may not hold this project's.
   */
  posts?: readonly SignedEventLike[];
}) {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const key = progressScope(
    relay,
    me,
    project ? `${project.record.author}:${project.record.id}` : "home",
  );
  return (
    <ProgressList compact={compact} key={key} posts={posts} project={project} />
  );
}

/** Whether the project's page has a Work tab: it runs its work through a DAO, which an idea does not have yet. */
function hasWorkTab(launch: Launch): boolean {
  return !isIdea(launch.record) && daoOfLaunch(launch) !== null;
}

interface Source {
  launch: Launch;
  update: LaunchUpdate;
}

function SourceBody({ source }: { source: Source | null }) {
  if (!source) return null;
  return (
    <UpdateBody
      launch={source.launch}
      max={600}
      update={source.update}
      workTab={hasWorkTab(source.launch)}
    />
  );
}

function ProgressList({
  project,
  compact,
  posts,
}: {
  project?: Launch;
  compact: boolean;
  posts?: readonly SignedEventLike[];
}) {
  const launches = useLaunches();
  const notes = useFeedNotes();
  const lists = useMyLists();
  const { tallies } = useVoteTallies();
  const { seen, mark, markBatch } = useProgressSeen();
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const [filter, setFilter] = useState<"following" | "all">("following");
  const [limit, setLimit] = useState(project ? (compact ? 2 : 6) : 5);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(
    () => new Set(),
  );
  const [message, setMessage] = useState<string | null>(null);
  // Freeze the previous visit for this mounted project; updates read during this visit do not erase its digest.
  const [baseline] = useState(() => seen);
  const all = useMemo(
    () =>
      projectProgress(
        project ? [project] : (launches.data ?? []),
        posts ?? (notes.data ?? []).map((n) => n.event),
      ),
    [project, launches.data, notes.data, posts],
  );
  // The update record behind a row, when it is one (a post marked as an update has none): its parts and help request.
  const sources = useMemo(() => {
    const byCoordinate = new Map<string, Launch>();
    for (const l of project ? [project] : (launches.data ?? []))
      byCoordinate.set(`37001:${l.record.author}:${l.record.id}`, l);
    return byCoordinate;
  }, [project, launches.data]);
  const raw = (item: { coordinate: string; id: string }): Source | null => {
    if (compact) return null;
    const launch = sources.get(item.coordinate);
    const update = launch?.updates.find((u) => u.id === item.id);
    return launch && update ? { launch, update } : null;
  };
  const followed = followedLaunches(lists.data?.bookmarks ?? null);
  const mine = new Set(
    (launches.data ?? [])
      .filter(
        (l) =>
          l.record.author === me || l.record.team.some((t) => t.pubkey === me),
      )
      .map((l) => `37001:${l.record.author}:${l.record.id}`),
  );
  const hasFollowing = followed.size + mine.size > 0;
  const followingReady = !me || lists.isSuccess;
  const inScope = all.filter(
    (i) =>
      project ||
      filter === "all" ||
      (followingReady && !hasFollowing) ||
      followed.has(i.coordinate) ||
      mine.has(i.coordinate),
  );
  const hash = useRouterState({ select: (state) => state.location.hash });
  const linkedId = hash.replace(/^#?update-/, "");
  const focusedIndex =
    project && /^[a-f0-9]{64}$/i.test(linkedId)
      ? inScope.findIndex((i) => i.id === linkedId)
      : -1;
  const visible = inScope.slice(0, Math.max(limit, focusedIndex + 1));
  const focusedReport = useRef<string | null>(null);
  const names = useUserNames(visible.map((i) => i.author));
  const scope = useCallback(
    (coordinate: string) => progressScope(relay, me, coordinate),
    [relay, me],
  );
  const history = project ? baseline : seen;
  const isNew = (coordinate: string, id: string) =>
    Boolean(
      !acknowledged.has(id) &&
        history[scope(coordinate)] &&
        !history[scope(coordinate)].ids.includes(id),
    );
  const fresh = inScope.filter((i) => isNew(i.coordinate, i.id)).length;
  const failed = launches.isError || notes.isError;
  const ready = launches.isSuccess && notes.isSuccess;
  const visibleSignature = JSON.stringify(
    visible.map((i) => [i.coordinate, i.id]),
  );
  const visitingProject = Boolean(project);
  // Record only rendered reports after successful reads; keep the previous visit frozen for this digest.
  useEffect(() => {
    if (!visitingProject || !ready) return;
    const markVisible = () => {
      if (document.visibilityState !== "visible") return;
      const pairs = JSON.parse(visibleSignature) as [string, string][];
      const grouped = new Map<string, string[]>();
      for (const [coordinate, id] of pairs)
        grouped.set(coordinate, [...(grouped.get(coordinate) ?? []), id]);
      for (const [coordinate, ids] of grouped)
        if (!mark(scope(coordinate), ids))
          setMessage(
            "This browser could not remember your visit. You can still read the updates.",
          );
    };
    markVisible();
    document.addEventListener("visibilitychange", markVisible);
    return () => document.removeEventListener("visibilitychange", markVisible);
  }, [visibleSignature, ready, visitingProject, mark, scope]);
  useEffect(() => {
    if (!project || focusedIndex < 0 || focusedReport.current === linkedId)
      return;
    const frame = requestAnimationFrame(() => {
      const report = document.getElementById(`update-${linkedId}`);
      report?.scrollIntoView({ block: "center" });
      report?.focus({ preventScroll: true });
      if (report) focusedReport.current = linkedId;
    });
    return () => cancelAnimationFrame(frame);
  }, [project, focusedIndex, linkedId]);
  const catchUp = () => {
    const saved = markBatch(
      [...new Set(visible.map((i) => i.coordinate))].map((coordinate) => [
        scope(coordinate),
        visible.filter((i) => i.coordinate === coordinate).map((i) => i.id),
      ]),
    );
    if (saved)
      setAcknowledged((old) => new Set([...old, ...visible.map((i) => i.id)]));
    setMessage(
      saved
        ? "The updates shown here are marked as read in this browser."
        : "This browser could not save your reading history.",
    );
  };
  return (
    <section
      className="glass rounded-2xl border p-4"
      aria-label="Project progress"
      data-testid="project-progress"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold">
            {project
              ? history[
                  scope(`37001:${project.record.author}:${project.record.id}`)
                ]
                ? "Since your last visit"
                : "Latest project progress"
              : "Project progress"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {fresh ? `${fresh} new to you · ` : ""}
            {/* A project's own page lists its team's updates only: submitted work is shown with the work. */}
            {project
              ? "Updates from the team."
              : "Updates from the team and work people submitted."}
          </p>
        </div>
        {!project ? (
          <fieldset className="flex gap-1" aria-label="Progress filter">
            {(["following", "all"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "all"
                  ? "All"
                  : hasFollowing
                    ? "Following & yours"
                    : "Projects I follow"}
              </Button>
            ))}
          </fieldset>
        ) : null}
      </div>
      {failed ? (
        <div className="mt-3 text-sm" role="status">
          Could not read all project updates. This list may be incomplete.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void launches.refetch();
              void notes.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {!project && filter === "following" && lists.isError ? (
        <p className="mt-2 text-sm" role="status">
          Could not read which projects you follow.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void lists.refetch()}
          >
            Try again
          </Button>
        </p>
      ) : null}
      {!ready && !failed && visible.length === 0 ? (
        <p className="mt-3 text-sm">Loading updates…</p>
      ) : null}
      {ready && !visible.length ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No updates here yet. Follow a project, or share what you finished, the
          work you made and what comes next.
        </p>
      ) : null}
      {project &&
      ready &&
      /^[a-f0-9]{64}$/i.test(linkedId) &&
      focusedIndex < 0 ? (
        <p className="mt-2 text-sm" role="status">
          That update is not among the latest ones loaded here. This does not
          mean it was deleted.
        </p>
      ) : null}
      <ol className="mt-3 space-y-3">
        {visible.map((i) => (
          <li
            key={i.id}
            id={`update-${i.id}`}
            tabIndex={-1}
            className="rounded-xl border border-border bg-background/60 p-3"
            data-testid="project-progress-item"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <Link
                to="/launchpad/$launchId"
                params={{ launchId: i.project.id }}
                search={{ author: i.project.author }}
                className="font-semibold text-foreground underline"
              >
                {i.project.name}
              </Link>
              <span>
                {i.evidence
                  ? `Work submitted by ${names(i.author)}`
                  : "Team update"}
                {isNew(i.coordinate, i.id) ? " · New to you" : ""} ·{" "}
                {new Date(i.at * 1000).toLocaleDateString()}
              </span>
            </div>
            <h3 className="mt-2 break-words text-sm font-semibold">
              {i.title}
            </h3>
            {/* A weekly update shows its parts and the help it asks for; the short preview on an overview keeps to words,
                because the card above it already carries the request. */}
            {raw(i) ? (
              <SourceBody source={raw(i)} />
            ) : (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {i.text.length > (compact ? 180 : 600)
                  ? `${i.text.slice(0, compact ? 180 : 600)}…`
                  : i.text}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {progressArtifacts(i.text).map((url, index) => (
                <a
                  key={url}
                  className="max-w-full truncate text-sm underline"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Artifact {index + 1} · {new URL(url).hostname}
                </a>
              ))}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>By {names(i.author)}</span>
              {i.evidence ? (
                <Chip tone="warning">Not approved yet</Chip>
              ) : (
                <Chip>From the team</Chip>
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <VoteButtons
                label={i.title}
                tally={tallies.get(i.id) ?? EMPTY_TALLY}
                target={i.event}
                testId={`progress-vote-${i.id}`}
              />
              <Link
                className="text-sm underline"
                to="/launchpad/$launchId"
                params={{ launchId: i.project.id }}
                search={{ author: i.project.author, tab: "discussion" }}
              >
                Discuss project
              </Link>
              {/* An icon with its name for screen readers and on hover: as words it wrapped onto a line of its own on a
                  phone, detached from the update it copies. */}
              <Button
                aria-label="Copy update link"
                size="icon"
                title="Copy update link"
                variant="ghost"
                onClick={async () => {
                  const url = new URL(
                    `/launchpad/${encodeURIComponent(i.project.id)}`,
                    location.origin,
                  );
                  url.searchParams.set("author", i.project.author);
                  url.searchParams.set("tab", "updates");
                  url.hash = `update-${i.id}`;
                  try {
                    if (!navigator.clipboard)
                      throw new Error("Clipboard unavailable");
                    await navigator.clipboard.writeText(url.href);
                    setMessage("Update link copied.");
                  } catch {
                    setMessage(
                      "Could not copy the link. Open the project's Updates tab to share it.",
                    );
                  }
                }}
              >
                <LinkIcon aria-hidden className="h-4 w-4" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        {inScope.length > visible.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLimit((n) => n + 10)}
          >
            More progress
          </Button>
        ) : null}
        {visible.length ? (
          <Button size="sm" variant="outline" onClick={catchUp}>
            Mark shown updates as read
          </Button>
        ) : null}
      </div>
      {all.length >= 100 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the latest 100 updates.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-xs">
          {message}
        </p>
      ) : null}
    </section>
  );
}
