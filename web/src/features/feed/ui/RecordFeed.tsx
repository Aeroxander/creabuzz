/**
 * Home's Updates tab: what projects put on the record, newest first, one compact card per signed record with the
 * project's name. Updates (with the founder's answers to earlier promises), goals reached, missed or changed, help
 * wanted (with "I can help" on the card), and work accepted.
 *
 * Someone signed in reads the projects they started, help or follow. A visitor, or someone tied to no project yet,
 * reads every listed project instead, is told so, and can follow a project from any of its cards.
 */

import { Link } from "@tanstack/react-router";
import { Link as LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  needAccountTo,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { GOAL_STATE_LABEL } from "@/features/launchpad/lib/goals";
import { PART_HEADINGS } from "@/features/launchpad/lib/weekly-update";
import {
  launchCoordinate,
  type Launch,
  type LaunchRecord,
} from "@/features/launchpad/models";
import { HelpRequestCard } from "@/features/launchpad/ui/HelpRequestCard";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { readableError } from "@/shared/lib/readable-error";
import { relativeTime } from "@/shared/lib/relative-time";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

import { progressArtifacts } from "../lib/project-progress";
import { answersLine, type FeedItem, itemLabel } from "../lib/record-feed";
import { useLaunchFollows } from "../use-launch-follows";
import { progressScope, useProgressSeen } from "../use-progress-seen";
import { useFeedScope, useRecordFeed } from "../use-record-feed";

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function RecordFeed() {
  const me = existingUserPubkey();
  const scoped = useFeedScope();
  const feed = useRecordFeed(scoped.scope);
  const follows = useLaunchFollows();
  const byCoordinate = useMemo(() => {
    const map = new Map<string, LaunchRecord>();
    for (const record of scoped.scope?.projects ?? [])
      map.set(launchCoordinate(record.author, record.id), record);
    return map;
  }, [scoped.scope]);
  const names = useUserNames(
    feed.items.flatMap((item) =>
      item.kind === "work" ? [item.author, item.helper] : [item.author],
    ),
  );
  // What this browser has shown the reader before, per project: a record it has not shown is marked new. A project
  // never opened here has no history, so nothing in it is called new (everything would be).
  const { seen, markBatch } = useProgressSeen();
  const relay = relayWsUrl();
  const [message, setMessage] = useState<string | null>(null);
  const isNew = (item: FeedItem) => {
    const history = seen[progressScope(relay, me, item.coordinate)];
    return Boolean(history && !history.ids.includes(item.id));
  };
  const fresh = feed.items.filter(isNew).length;
  const markRead = () => {
    const groups = new Map<string, string[]>();
    for (const item of feed.items)
      groups.set(item.coordinate, [
        ...(groups.get(item.coordinate) ?? []),
        item.id,
      ]);
    // One action, one write, however many projects are shown.
    const saved = markBatch(
      [...groups].map(([coordinate, ids]) => [
        progressScope(relay, me, coordinate),
        ids,
      ]),
    );
    setMessage(
      saved
        ? "The records shown here are marked as read in this browser."
        : "This browser could not save your reading history.",
    );
  };
  const follow = (coordinate: string) => {
    // Signed out: the account dialog, then the person can come back to the same button.
    if (me === null) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    follows.toggle(coordinate);
  };

  const { scope } = scoped;
  return (
    <section
      aria-label="Project records"
      className="flex flex-col gap-3"
      data-testid="record-feed"
    >
      {scoped.failed ? (
        <p
          className="text-sm"
          data-testid="record-feed-scope-failed"
          role="alert"
        >
          Couldn't read which projects are yours, so their records can't be
          shown.{" "}
          <Button
            onClick={scoped.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : scoped.loading || !scope ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading project records…
        </p>
      ) : (
        <>
          <p
            className="text-sm text-muted-foreground"
            data-mode={scope.mode}
            data-testid="record-feed-scope"
          >
            {scope.mode === "yours"
              ? "From the projects you started, help or follow."
              : me === null
                ? `This shows every listed project. ${needAccountTo("follow the ones you care about")}`
                : scoped.followsFailed
                  ? "This shows every listed project, because which projects you follow could not be read."
                  : "You follow no projects yet, so this shows every listed project. Follow one and this becomes your own feed."}
          </p>
          {scoped.followsFailed ? (
            <p
              className="text-sm"
              data-testid="record-feed-follows-failed"
              role="alert"
            >
              Couldn't read which projects you follow, so their records are not
              here.{" "}
              <Button
                onClick={scoped.retryFollows}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </p>
          ) : null}
          {fresh > 0 ? (
            <p className="text-sm font-medium" data-testid="record-feed-new">
              {fresh} new to you
            </p>
          ) : null}
          {scope.cut ? (
            <p
              className="text-xs"
              data-testid="record-feed-scope-cut"
              role="status"
            >
              {scope.mode === "yours"
                ? "You have more projects than this feed follows at once, so some are not in it."
                : "There are more listed projects than this feed follows at once: these are the newest."}
            </p>
          ) : null}
          {feed.error ? (
            <p
              className="text-sm"
              data-testid="record-feed-failed"
              role="alert"
            >
              Couldn't load project records. {readableError(feed.error)}{" "}
              <Button
                onClick={feed.refetch}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </p>
          ) : feed.loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading project records…
            </p>
          ) : feed.items.length === 0 && !feed.hasMore && !feed.moreError ? (
            <p className="text-sm" data-testid="record-feed-empty">
              {feed.idle
                ? "No projects on this server yet. "
                : "Nothing on the record yet from these projects. "}
              <Link className="underline" to="/start">
                Start a project
              </Link>
              {" or "}
              <Link className="underline" to="/discover">
                find one to follow
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {feed.items.map((item) => {
                const record = byCoordinate.get(item.coordinate);
                if (!record) return null;
                return (
                  <li key={item.id}>
                    <RecordCard
                      followable={
                        scope.mode === "everyone" && record.author !== me
                      }
                      followed={follows.followed.has(item.coordinate)}
                      followDisabled={!follows.ready || follows.pending}
                      fresh={isNew(item)}
                      item={item}
                      names={names}
                      onMessage={setMessage}
                      onFollow={() => follow(item.coordinate)}
                      record={record}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {feed.moreError ? (
            <p
              className="text-sm"
              data-testid="record-feed-more-failed"
              role="alert"
            >
              Couldn't load older records. {readableError(feed.moreError)} The
              ones above are still here.{" "}
              <Button
                data-testid="record-feed-more-retry"
                disabled={feed.loadingMore}
                onClick={feed.loadMore}
                size="sm"
                type="button"
                variant="outline"
              >
                {feed.loadingMore ? "Loading…" : "Try again"}
              </Button>
            </p>
          ) : feed.hasMore ? (
            <div>
              <Button
                data-testid="record-feed-more"
                disabled={feed.loadingMore}
                onClick={feed.loadMore}
                size="sm"
                type="button"
                variant="outline"
              >
                {feed.loadingMore ? "Loading…" : "Show older records"}
              </Button>
            </div>
          ) : feed.cut ? (
            <p className="text-xs" data-testid="record-feed-cut" role="status">
              There are older records than this feed can reach. Each project's
              own page has all of its record.
            </p>
          ) : null}
          {feed.items.length > 0 ? (
            <div>
              <Button
                data-testid="record-feed-mark-read"
                onClick={markRead}
                size="sm"
                type="button"
                variant="outline"
              >
                Mark shown records as read
              </Button>
            </div>
          ) : null}
          {message ? (
            <p
              className="text-xs"
              data-testid="record-feed-message"
              role="status"
            >
              {message}
            </p>
          ) : null}
          {feed.workCut || feed.authorsCut ? (
            <p
              className="text-xs"
              data-testid="record-feed-partial"
              role="status"
            >
              Not everything behind these records could be read, so some
              accepted work or some teams' updates may be missing here. Each
              project's own page has all of its record.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function RecordCard({
  item,
  record,
  names,
  followable,
  followed,
  followDisabled,
  onFollow,
  fresh,
  onMessage,
}: {
  /** This browser has shown the project's records before, and not this one. */
  fresh: boolean;
  /** Says what came of copying a link. */
  onMessage: (message: string) => void;
  item: FeedItem;
  record: LaunchRecord;
  names: (pubkey: string) => string;
  followable: boolean;
  followed: boolean;
  followDisabled: boolean;
  onFollow: () => void;
}) {
  const label = itemLabel(item);
  // The help card reads its project on its own; it only needs the record and this one update.
  const launch = useMemo(
    (): Launch => ({
      record,
      bids: [],
      updates: item.kind === "update" ? [item.update] : [],
      proposals: [],
      receipts: [],
    }),
    [record, item],
  );
  return (
    <article
      aria-label={`${label}: ${record.name}`}
      className="glass rounded-2xl border p-4"
      data-kind={item.kind}
      data-testid="record-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm">
          <Link
            className="font-bold underline-offset-2 hover:underline"
            data-testid="record-card-project"
            params={{ launchId: record.id }}
            search={{ author: record.author }}
            to="/launchpad/$launchId"
          >
            {record.name}
          </Link>{" "}
          <span
            className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary-ink"
            data-testid="record-card-label"
          >
            {label}
          </span>{" "}
          <span className="text-xs text-muted-foreground">
            {relativeTime(item.at)}
            {fresh ? " · New to you" : ""}
          </span>
        </p>
        {followable ? (
          <Button
            aria-label={
              followed
                ? `Stop following ${record.name}`
                : `Follow ${record.name}`
            }
            aria-pressed={followed}
            data-testid="record-card-follow"
            disabled={followDisabled}
            onClick={onFollow}
            size="sm"
            type="button"
            variant={followed ? "outline" : "default"}
          >
            {followed ? "Following" : "Follow"}
          </Button>
        ) : null}
      </div>
      {item.kind === "goal" ? (
        <div className="mt-2 text-sm">
          <p className="break-words">
            <span className="font-semibold">
              {GOAL_STATE_LABEL[item.state]}:
            </span>{" "}
            {item.text}
          </p>
          {item.reason ? (
            <p className="mt-1 break-words text-muted-foreground">
              {item.reason}
            </p>
          ) : null}
        </div>
      ) : item.kind === "work" ? (
        <div className="mt-2 text-sm">
          <p className="break-words">{clip(item.what, 280)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Done by {names(item.helper)}. Checked by {names(item.author)}.
          </p>
        </div>
      ) : (
        <div className="mt-2 text-sm">
          <p className="break-words font-semibold">{item.update.title}</p>
          <p className="text-xs text-muted-foreground">
            By {names(item.author)}
          </p>
          {item.update.parts?.done ? (
            <p className="mt-1 whitespace-pre-wrap break-words">
              {clip(item.update.parts.done, 280)}
            </p>
          ) : !item.update.parts && item.update.body ? (
            <p className="mt-1 whitespace-pre-wrap break-words">
              {clip(item.update.body, 280)}
            </p>
          ) : null}
          {answersLine(item.answers) ? (
            <p className="mt-1 font-medium" data-testid="record-card-answers">
              {answersLine(item.answers)}
            </p>
          ) : null}
          {item.promises.length > 0 ? (
            <p className="mt-1 break-words text-muted-foreground">
              {PART_HEADINGS.next}: {clip(item.promises.join("; "), 200)}
            </p>
          ) : null}
          {item.help ? (
            <HelpRequestCard
              launch={launch}
              update={item.update}
              workTab={false}
            />
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {progressArtifacts(item.update.body).map((url, index) => (
              <a
                className="max-w-full truncate underline"
                href={url}
                key={url}
                rel="noreferrer"
                target="_blank"
              >
                Artifact {index + 1} · {new URL(url).hostname}
              </a>
            ))}
            <Link
              className="underline"
              params={{ launchId: record.id }}
              search={{ author: record.author, tab: "discussion" }}
              to="/launchpad/$launchId"
            >
              Discuss project
            </Link>
            <Button
              aria-label="Copy update link"
              onClick={async () => {
                const url = new URL(
                  `/launchpad/${encodeURIComponent(record.id)}`,
                  location.origin,
                );
                url.searchParams.set("author", record.author);
                url.searchParams.set("tab", "updates");
                url.hash = `update-${item.id}`;
                try {
                  if (!navigator.clipboard)
                    throw new Error("Clipboard unavailable");
                  await navigator.clipboard.writeText(url.href);
                  onMessage("Update link copied.");
                } catch {
                  onMessage(
                    "Could not copy the link. Open the project's Updates tab to share it.",
                  );
                }
              }}
              size="icon"
              title="Copy update link"
              type="button"
              variant="ghost"
            >
              <LinkIcon aria-hidden className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
