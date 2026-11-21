/**
 * The holder room, the project page's fifth tab (plan sections 4 and 7.6). Anyone can read it, signed in or not; who may write
 * is the server's call, from the network, and this tab only offers a place to write to someone it will accept, and says in plain
 * words what is wrong and what to do for everyone else. Posts are text. The team's own news and the work handed in appear
 * among the posts, labelled, and the team's newest notice is pinned at the top so a quiet room is never blank.
 */
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "../../lib/account";
import { displayText } from "@creaton/core/social/feed/feed-events.ts";
import { type ProfileMetadata, nameOf, useProfiles } from "../../lib/profiles";
import { useMutes } from "../../lib/mutes";
import { REPORTED_HIDDEN } from "../safety/safety-words";
import { useReported } from "../safety/reported";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { dayText, type ProjectNumbers } from "../money/numbers";
import type { SignedEvent } from "../posts/use-posts";
import type { Project } from "../project/project-record";
import { projectUpdates, useProjectActivity } from "../project/use-project";
import { useProjectTasks } from "../tasks/use-tasks";
import { HiddenSheet } from "./HiddenSheet";
import { PerksBlock } from "./PerksBlock";
import type { MenuChoice } from "./PostMenu";
import { RoomComposer } from "./RoomComposer";
import { RoomNotice } from "./RoomNotice";
import { RoomPostCard, type RoomTools } from "./RoomPostCard";
import { MuteSheet, RemoveSheet, ReportSheet } from "./RoomSheets";
import { RoomStatus } from "./RoomStatus";
import { type Notice, noticesOf } from "./room-notices";
import { buildRoom, isOfRoom, PAGE } from "./room-read";
import { markRoomSeen, seenKey } from "./room-seen";
import {
  COMPOSER_LABEL,
  EMPTY,
  HIDE_DONE,
  HIDES_UNKNOWN,
  NO_EARLIER,
  NOT_SAVED,
  PUBLIC_LINE,
  READ_CUT,
  READ_FAILED,
  READ_LINE,
  READ_LINE_OPEN,
  REMOVED_CUT,
  REMOVED_HEADING,
  removedLine,
  STOPS_CUT,
} from "./room-words";
import {
  NOTES_READ,
  roomOf,
  useRoomEvents,
  useRoomLike,
  useRoomMutesCut,
  useRoomPost,
  useRoomRemovals,
  useRoomReply,
  useStopWriting,
} from "./use-room";
import { useRoomStanding } from "./use-room-standing";

type Item =
  | {
      kind: "post";
      at: number;
      id: string;
      post: ReturnType<typeof buildRoom>["posts"][number];
    }
  | { kind: "notice"; at: number; id: string; notice: Notice };

export function RoomTab({
  project,
  numbers,
  profiles: pageProfiles,
  team,
}: {
  project: Project;
  numbers: ProjectNumbers | null;
  profiles: Record<string, ProfileMetadata> | undefined;
  team: readonly string[];
}) {
  const room = roomOf(project);
  const events = useRoomEvents(room, project.coordinate);
  const removals = useRoomRemovals(
    room,
    project.coordinate,
    events.data?.notes,
  );
  const { pubkey: me } = useAccount();
  // The page knows the team's names; the people who write in the room are named here, from what was read.
  const writers = useProfiles(
    [...new Set((events.data?.notes ?? []).map((e) => e.pubkey))].slice(0, 100),
  ).data;
  const profiles = useMemo(
    () => ({ ...writers, ...pageProfiles }),
    [writers, pageProfiles],
  );
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const activity = useProjectActivity(project);
  const tasks = useProjectTasks(project);
  const mutes = useMutes();
  const reported = useReported();
  const {
    standing,
    mutes: stops,
    retry,
  } = useRoomStanding(project, numbers, team);
  const stopsCut = useRoomMutesCut(project.coordinate, team);
  const post = useRoomPost(room);
  const reply = useRoomReply(room);
  const like = useRoomLike(room);
  const stop = useStopWriting(project.coordinate);
  const [pages, setPages] = useState(1);
  const [report, setReport] = useState<SignedEvent | null>(null);
  const [removing, setRemoving] = useState<SignedEvent | null>(null);
  const [stopping, setStopping] = useState<SignedEvent | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [justHidden, setJustHidden] = useState<{
    pubkey: string;
    name: string;
  } | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const view = useMemo(
    () =>
      room && events.data
        ? buildRoom({
            notes: events.data.notes,
            likes: events.data.likes,
            coordinate: project.coordinate,
            key: room.key,
            me,
            hidden: mutes.muted,
            reportedPosts: reported.reported,
          })
        : null,
    [events.data, room, project.coordinate, me, mutes.muted, reported.reported],
  );
  const notices = useMemo(
    () =>
      noticesOf({
        updates: activity.data ? projectUpdates(project, activity.data) : [],
        tasks: tasks.data?.tasks ?? [],
        roles: new Map(project.team.map((m) => [m.pubkey, m.role])),
      }),
    [activity.data, tasks.data, project],
  );
  const pinned = notices[0] ?? null;
  const items: Item[] = [
    ...(view?.posts ?? []).map(
      (p): Item => ({
        kind: "post",
        at: p.event.created_at,
        id: p.event.id,
        post: p,
      }),
    ),
    ...notices
      .slice(1)
      .map((n): Item => ({ kind: "notice", at: n.at, id: n.id, notice: n })),
  ].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const shown = items.slice(0, PAGE * pages);

  // The room has been looked at up to its newest thing: the tab's "New" dot goes.
  // Everything the room holds counts as seen, answers and the posts of people the reader hides included, so the dot is made from the
  // same newest-post read it is cleared by.
  const newest = Math.max(
    pinned?.at ?? 0,
    ...(events.data?.notes ?? [])
      .filter((e) => isOfRoom(e, project.coordinate, room?.key ?? ""))
      .map((e) => e.created_at),
  );
  useEffect(() => {
    if (view && newest > 0)
      markRoomSeen(seenKey(me, project.coordinate), newest);
  }, [view, newest, project.coordinate, me]);

  const tools: RoomTools = {
    me,
    founder: project.author,
    team: new Set(team),
    stopped: new Set((stops ?? []).map((m) => m.person)),
  };
  const canWrite = standing.kind === "write";
  // The status line below says "Only people who back this project can write here." for these two: the top line then says no more than "Anyone can read this room."
  const saysWhoMayNot =
    standing.kind === "signed-out" || standing.kind === "not-holding";
  const onChoose = (choice: MenuChoice, event: SignedEvent) => {
    const name = nameOf(profiles, event.pubkey);
    if (choice === "report") requireAccount(() => setReport(event));
    else if (choice === "remove") setRemoving(event);
    else if (choice === "stop") setStopping(event);
    else if (choice === "allow")
      stop.mutate(
        { person: event.pubkey, days: 0 },
        {
          onSuccess: () => toast(`${name} can write here again.`, "done"),
          onError: () => toast(NOT_SAVED, "problem"),
        },
      );
    else
      requireAccount(() =>
        mutes
          .hide(event.pubkey)
          .then(() => setJustHidden({ pubkey: event.pubkey, name }))
          .catch((error: Error) => toast(error.message, "problem")),
      );
  };

  if (!room) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="room">
      <div className="flex flex-col gap-1">
        <p className="text-sm" data-testid="room-read-line">
          {saysWhoMayNot ? READ_LINE_OPEN : READ_LINE}
        </p>
        <p className="text-xs text-muted">{PUBLIC_LINE}</p>
      </div>
      {mutes.failed ? (
        <p className="text-sm text-muted" data-testid="room-hides-unknown">
          {HIDES_UNKNOWN}
        </p>
      ) : null}
      <PerksBlock isFounder={me === project.author} project={project} />
      <RoomStatus
        now={now}
        numbers={numbers}
        onRetry={retry}
        standing={standing}
      >
        <RoomComposer
          draftKey={`${me ?? ""}:${project.coordinate}`}
          label={COMPOSER_LABEL}
          send={(text) => post.mutateAsync({ text })}
        />
      </RoomStatus>
      {justHidden ? (
        <Card
          className="flex flex-col gap-2"
          data-testid="room-hidden-note"
          role="status"
        >
          <p className="text-sm">{HIDE_DONE(justHidden.name)}</p>
          <div>
            <Button
              data-testid="room-hide-undo"
              onClick={() => {
                void mutes
                  .showAgain(justHidden.pubkey)
                  .then(() => setJustHidden(null))
                  .catch(() => toast(NOT_SAVED, "problem"));
              }}
              size="sm"
              variant="secondary"
            >
              Undo
            </Button>
          </div>
        </Card>
      ) : null}
      {mutes.muted.size > 0 ? (
        <div>
          <Button
            data-testid="room-hidden-open"
            onClick={() => setHiddenOpen(true)}
            size="sm"
            variant="ghost"
          >
            {`Hidden people (${mutes.muted.size})`}
          </Button>
        </div>
      ) : null}
      {pinned ? (
        <RoomNotice notice={pinned} pinned profiles={profiles} />
      ) : null}
      {events.isError ? (
        <Card className="flex flex-col gap-2" data-testid="room-read-failed">
          <p className="text-sm">{READ_FAILED}</p>
          <div>
            <Button
              onClick={() => void events.refetch()}
              size="sm"
              variant="secondary"
            >
              Try again
            </Button>
          </div>
        </Card>
      ) : events.isPending ? (
        <Card className="h-24 animate-pulse" data-testid="room-loading" />
      ) : shown.length === 0 && !pinned ? (
        <p className="text-sm text-muted" data-testid="room-empty">
          {EMPTY}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="room-list">
          {shown.map((item) =>
            item.kind === "notice" ? (
              <li key={item.id}>
                <RoomNotice notice={item.notice} profiles={profiles} />
              </li>
            ) : (
              <li key={item.id}>
                <RoomPostCard
                  canWrite={canWrite}
                  engagement={item.post.engagement}
                  event={item.post.event}
                  onChoose={onChoose}
                  onLike={(e) => like.mutateAsync(e)}
                  onReply={(text, root, parent) =>
                    reply.mutateAsync({ text, root, parent })
                  }
                  profiles={profiles}
                  root={item.post.event}
                  tools={tools}
                >
                  {item.post.replies.length > 0 ? (
                    <section
                      aria-label={`Replies to ${nameOf(profiles, item.post.event.pubkey)}`}
                      className="flex flex-col gap-3"
                    >
                      {item.post.replies.map((r) => (
                        <RoomPostCard
                          canWrite={canWrite}
                          engagement={r.engagement}
                          event={r.event}
                          key={r.event.id}
                          nested
                          onChoose={onChoose}
                          onLike={(e) => like.mutateAsync(e)}
                          onReply={(text, root, parent) =>
                            reply.mutateAsync({ text, root, parent })
                          }
                          profiles={profiles}
                          root={item.post.event}
                          tools={tools}
                        />
                      ))}
                    </section>
                  ) : null}
                </RoomPostCard>
              </li>
            ),
          )}
        </ul>
      )}
      {stopsCut && me && (me === project.author || team.includes(me)) ? (
        <p className="text-xs text-muted" data-testid="room-stops-cut">
          {STOPS_CUT}
        </p>
      ) : null}
      {removals.data && removals.data.shown.length > 0 ? (
        <section
          aria-labelledby="room-removed-heading"
          className="flex flex-col gap-2"
          data-testid="room-removed"
        >
          <h3 className="text-sm font-semibold" id="room-removed-heading">
            {REMOVED_HEADING}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {removals.data.shown.map((r) => (
              <li className="text-sm text-muted" key={r.target}>
                {removedLine(displayText(r.reason))}{" "}
                <span className="text-xs">{dayText(r.at)}</span>
              </li>
            ))}
          </ul>
          {removals.data.cut ? (
            <p className="text-xs text-muted">{REMOVED_CUT}</p>
          ) : null}
        </section>
      ) : null}
      {items.length > shown.length ? (
        <div>
          <Button
            data-testid="room-more"
            onClick={() => setPages((p) => p + 1)}
            size="sm"
            variant="secondary"
          >
            Show earlier posts
          </Button>
        </div>
      ) : (events.data?.notes.length ?? 0) >= NOTES_READ ? (
        <p className="text-sm text-muted" data-testid="room-read-cut">
          {READ_CUT}
        </p>
      ) : pages > 1 ? (
        <p className="text-sm text-muted" data-testid="room-no-more">
          {NO_EARLIER}
        </p>
      ) : null}
      <ReportSheet
        afterSent={() => (
          <p className="text-sm text-muted">{REPORTED_HIDDEN}</p>
        )}
        onOpenChange={(open) => !open && setReport(null)}
        onSent={(post) => reported.add(post.id)}
        post={report}
      />
      <RemoveSheet
        onOpenChange={(open) => !open && setRemoving(null)}
        post={removing}
      />
      <MuteSheet
        coordinate={project.coordinate}
        name={stopping ? nameOf(profiles, stopping.pubkey) : ""}
        onOpenChange={(open) => !open && setStopping(null)}
        person={stopping?.pubkey ?? null}
      />
      <HiddenSheet
        hidden={[...mutes.muted]}
        onOpenChange={setHiddenOpen}
        onShowAgain={(pubkey) =>
          void mutes.showAgain(pubkey).catch(() => toast(NOT_SAVED, "problem"))
        }
        open={hiddenOpen}
        pending={mutes.pending}
        unknown={mutes.failed}
      />
    </div>
  );
}
