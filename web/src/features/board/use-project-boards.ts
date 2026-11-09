/**
 * Boards that belong to a project: reading which they are, naming a board in a project's record, and making a
 * project's supporters and founders boards.
 *
 * The tie is the project's record (see `lib/project-boards.ts`), so only the person who published the project can
 * name boards in it. Reading is for everyone.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useChannels } from "@/features/channels/use-channels";
import { recordToInput } from "@/features/launchpad/lib/record-input";
import {
  fetchLaunches,
  launchesQueryKey,
  useCreateLaunch,
  useLaunches,
} from "@/features/launchpad/use-launches";
import type { Launch } from "@/features/launchpad/models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { openUserPublisher } from "@/shared/lib/publish-as-user";
import { failureWords } from "@/shared/lib/readable-error";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { nameBoardsInRecord } from "./lib/name-boards";
import {
  type BoardProject,
  boardOwners,
  boardProject,
  boardsOfProject,
  boardsTheFounderRuns,
} from "./lib/project-boards";
import {
  createProjectStarterBoards,
  type StarterMemoStore,
} from "./lib/project-starter";
import { starterDrafts } from "./lib/starter-boards";

const KIND_CHANNEL_METADATA = 39000;

const KIND_BOARD_MEMBERS = 39002;
/** The server refuses a read that names more boards than this. */
const OWNER_READ_CHUNK = 100;
const boardOwnersQueryKey = ["board-owners"];

/**
 * Who runs each of these boards, read from the server's membership records. Asked in pieces the server accepts. A
 * failed piece fails the whole read, so a board is never counted or left out on a guess.
 */
function useBoardOwners(boardIds: readonly string[]) {
  const sorted = useMemo(() => [...new Set(boardIds)].sort(), [boardIds]);
  return useQuery({
    queryKey: [...boardOwnersQueryKey, sorted],
    enabled: sorted.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const url = relayWsUrl();
      const pieces: string[][] = [];
      for (let i = 0; i < sorted.length; i += OWNER_READ_CHUNK)
        pieces.push(sorted.slice(i, i + OWNER_READ_CHUNK));
      const records = await Promise.all(
        pieces.map((piece) =>
          queryEvents(url, {
            kinds: [KIND_BOARD_MEMBERS],
            "#d": piece,
            limit: piece.length * 2,
          }),
        ),
      );
      return boardOwners(records.flat());
    },
  });
}

/** The ids of the boards among a set of channels the records name: rooms are never looked up. */
function useNamedBoardIds(projects: readonly BoardProject[]): {
  ids: string[];
  loading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const { channels, isLoading, error, refetch } = useChannels();
  const ids = useMemo(() => {
    const forums = new Set(
      channels
        .filter((channel) => channel.type === "forum")
        .map((channel) => channel.id.toLowerCase()),
    );
    return [
      ...new Set(
        projects.flatMap((project) =>
          project.channelIds.filter((id) => forums.has(id)),
        ),
      ),
    ];
  }, [channels, projects]);
  return { ids, loading: isLoading, error, refetch: () => void refetch() };
}

/**
 * Every project on this server, with the boards its founder runs. A board a record names that its founder does not run
 * is left out (see `boardsTheFounderRuns`). Empty while they load or when they cannot be read.
 */
export function useBoardProjects(): {
  projects: BoardProject[];
  isLoading: boolean;
  failed: boolean;
} {
  const launches = useLaunches();
  const named = useMemo(
    () => (launches.data ?? []).map((launch) => boardProject(launch.record)),
    [launches.data],
  );
  const wanted = useNamedBoardIds(named);
  const owners = useBoardOwners(wanted.ids);
  const projects = useMemo(
    () =>
      owners.data
        ? named.map((project) => boardsTheFounderRuns(project, owners.data))
        : [],
    [named, owners.data],
  );
  return {
    projects,
    isLoading: launches.isLoading || wanted.loading || owners.isLoading,
    failed: launches.isError || owners.isError,
  };
}

/** The projects the signed-in person published: the ones they can add boards to. */
export function useMyProjects(): Launch[] {
  const launches = useLaunches();
  const me = existingUserPubkey();
  return useMemo(
    () =>
      me === null
        ? []
        : (launches.data ?? []).filter((launch) => launch.record.author === me),
    [launches.data, me],
  );
}

/** One project's boards, as the server lists them: the ones its record names that its founder runs. */
export function useProjectBoardsOf(launch: Launch) {
  const { channels, isLoading, error, refetch } = useChannels();
  const named = useMemo(() => boardProject(launch.record), [launch.record]);
  const wanted = useNamedBoardIds(useMemo(() => [named], [named]));
  const owners = useBoardOwners(wanted.ids);
  const boards = useMemo(
    () =>
      owners.data
        ? boardsOfProject(
            boardsTheFounderRuns(named, owners.data),
            channels.filter((channel) => channel.type === "forum"),
          )
        : [],
    [named, owners.data, channels],
  );
  return {
    boards,
    loading: isLoading || owners.isLoading,
    error: error ?? owners.error,
    retry: () => {
      void refetch();
      void owners.refetch();
    },
  };
}

/** The browser's storage, or one that keeps nothing when it is refused (a private window). */
function memoStore(): StarterMemoStore {
  try {
    return localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

async function boardExists(id: string): Promise<boolean> {
  const records = await queryEvents(relayWsUrl(), {
    kinds: [KIND_CHANNEL_METADATA],
    "#d": [id],
    limit: 1,
  });
  return records.length > 0;
}

/**
 * Name boards in a project's record: `save` is the record's save. The record is read again first, so a project edited
 * since the page loaded it is not put back to how the page last saw it. Resolves with how many channels the founder had
 * picked that no longer fit.
 */
function useNameBoards() {
  const save = useCreateLaunch();
  const client = useQueryClient();
  const { channels } = useChannels();
  const forums = useMemo(
    () =>
      new Set(
        channels
          .filter((channel) => channel.type === "forum")
          .map((channel) => channel.id.toLowerCase()),
      ),
    [channels],
  );
  return useCallback(
    async (launch: Launch, ids: readonly string[]): Promise<number> => {
      const dropped = await nameBoardsInRecord(
        {
          readLatest: async () => {
            const launches = await client.fetchQuery({
              queryKey: launchesQueryKey,
              queryFn: fetchLaunches,
              staleTime: 0,
            });
            const latest = launches.find(
              (entry) =>
                entry.record.id === launch.record.id &&
                entry.record.author.toLowerCase() ===
                  launch.record.author.toLowerCase(),
            );
            if (!latest)
              throw new Error(
                "Couldn't find this project's saved record. Reload the page and try again.",
              );
            return latest.record;
          },
          save: async (record, channels) => {
            await save.mutateAsync(recordToInput(record, { channels }));
          },
        },
        ids,
        forums,
      );
      void client.invalidateQueries({ queryKey: boardOwnersQueryKey });
      return dropped;
    },
    [client, save, forums],
  );
}

/** Put boards that exist under a project. Throws with the server's reason when the record is refused. */
export function useTieBoards() {
  return useNameBoards();
}

export type StarterState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "error"; message: string };

/**
 * Make the project's supporters and founders boards inside it. `boards` are the project's boards; only the missing
 * ones are made. `create` resolves with how many of the founder's other picked channels no longer fit in the
 * record (0 when all did), or null when it stopped on a problem, which `state` then says.
 */
export function useProjectStarterBoards(
  launch: Launch,
  boards: readonly { name: string; description: string }[],
) {
  const client = useQueryClient();
  const name = useNameBoards();
  const [state, setState] = useState<StarterState>({ phase: "idle" });

  const create = useCallback(async (): Promise<number | null> => {
    setState({ phase: "working" });
    const publisher = openUserPublisher();
    let dropped = 0;
    try {
      await createProjectStarterBoards({
        scope: {
          relay: relayWsUrl(),
          founder: launch.record.author,
          projectId: launch.record.id,
        },
        existing: boards,
        store: memoStore(),
        newId: () => crypto.randomUUID(),
        exists: boardExists,
        create: async (board, id) => {
          await publisher.publish(
            starterDrafts(board, id).create,
            `The server didn't create the ${board.name} board. Try again.`,
          );
        },
        seed: async (board, id) => {
          await publisher.publish(
            starterDrafts(board, id).seed,
            `The ${board.name} board was created, but its first post wasn't accepted.`,
          );
        },
        tie: async (ids) => {
          dropped = await name(launch, ids);
        },
      });
      setState({ phase: "idle" });
      return dropped;
    } catch (error) {
      setState({
        phase: "error",
        message: failureWords(error, "Couldn't set up the boards. Try again.")
          .text,
      });
      return null;
    } finally {
      publisher.close();
      await client.invalidateQueries({ queryKey: ["channels"] });
      await client.invalidateQueries({ queryKey: boardOwnersQueryKey });
      await client.invalidateQueries({ queryKey: launchesQueryKey });
    }
  }, [launch, boards, client, name]);

  return { state, create };
}
