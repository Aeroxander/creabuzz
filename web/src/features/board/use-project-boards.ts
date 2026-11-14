/**
 * Boards that belong to a project: reading which they are, naming a board in a project's record, and making a
 * project's supporters and founders boards.
 *
 * The tie is the project's record (see `lib/project-boards.ts`), so only the person who published the project can
 * name boards in it. Reading is for everyone.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type { Channel } from "@/features/channels/use-channels";
import { recordToInput } from "@/features/launchpad/lib/record-input";
import {
  fetchOwnRecord,
  launchesQueryKey,
  useCreateLaunch,
  useLaunches,
} from "@/features/launchpad/use-launches";
import type { Launch } from "@/features/launchpad/models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { openUserPublisher } from "@/shared/lib/publish-as-user";
import { failureWords } from "@/shared/lib/readable-error";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { nameBoardsInRecord } from "./lib/name-boards";
import {
  KIND_CHANNEL_METADATA,
  type ReadRecords,
  readNamedBoards,
  readRecordsNaming,
} from "./lib/named-boards";
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

const KIND_BOARD_MEMBERS = 39002;
const boardOwnersQueryKey = ["board-owners"];
/** Under "channels", so whatever reads the channel list again reads these again too. */
const namedBoardsQueryKey = ["channels", "named"];

const NO_BOARDS: readonly Channel[] = [];

const readServer: ReadRecords<NostrEvent> = (filter) =>
  queryEvents(relayWsUrl(), filter);

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
    queryFn: async () =>
      boardOwners(
        await readRecordsNaming(readServer, KIND_BOARD_MEMBERS, sorted),
      ),
  });
}

/**
 * The boards these records name, each read by its id (see `lib/named-boards.ts`): never looked up in the first page of
 * the channel list, which an older board is not on. Rooms the records name are asked for with them and left out.
 */
function useNamedBoards(projects: readonly BoardProject[]) {
  const sorted = useMemo(
    () =>
      [...new Set(projects.flatMap((project) => project.channelIds))].sort(),
    [projects],
  );
  const query = useQuery({
    queryKey: [...namedBoardsQueryKey, sorted],
    enabled: sorted.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: () => readNamedBoards(readServer, sorted),
  });
  const ids = useMemo(
    () => (query.data ?? []).map((board) => board.id.toLowerCase()),
    [query.data],
  );
  return { query, boards: query.data, ids };
}

/**
 * Every project on this server, with the boards its founder runs. A board a record names that its founder does not run
 * is left out (see `boardsTheFounderRuns`). Empty while they load and when they cannot be read: `failed` says which, so
 * a list grouped from nothing is never shown as the answer.
 */
export function useBoardProjects(): {
  projects: BoardProject[];
  isLoading: boolean;
  failed: boolean;
  /** Read again whatever could not be read. */
  retry: () => void;
} {
  const launches = useLaunches();
  const named = useMemo(
    () => (launches.data ?? []).map((launch) => boardProject(launch.record)),
    [launches.data],
  );
  const wanted = useNamedBoards(named);
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
    isLoading: launches.isLoading || wanted.query.isLoading || owners.isLoading,
    failed: launches.isError || wanted.query.isError || owners.isError,
    retry: () => {
      if (launches.isError) void launches.refetch();
      if (wanted.query.isError) void wanted.query.refetch();
      if (owners.isError) void owners.refetch();
    },
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

/**
 * One project's boards: the ones its record names that its founder runs, each read by its id. `boards` is empty while
 * they load and when a read fails, so ask `knownBoards` (lib/named-boards.ts) before taking an empty list to mean the
 * project has none.
 */
export function useProjectBoardsOf(launch: Launch) {
  const named = useMemo(() => boardProject(launch.record), [launch.record]);
  const wanted = useNamedBoards(useMemo(() => [named], [named]));
  const owners = useBoardOwners(wanted.ids);
  const boards = useMemo(
    () =>
      wanted.boards && owners.data
        ? boardsOfProject(
            boardsTheFounderRuns(named, owners.data),
            wanted.boards,
          )
        : [],
    [named, owners.data, wanted.boards],
  );
  return {
    boards,
    loading: wanted.query.isLoading || owners.isLoading,
    error: wanted.query.error ?? owners.error,
    retry: () => {
      void wanted.query.refetch();
      if (wanted.ids.length > 0) void owners.refetch();
    },
  };
}

/**
 * The boards a project's record names, each read by its id, whoever runs them: where a decision of the project can be
 * talked about. Null (no project known yet) reads nothing. `boards` is empty while they load and when the read fails;
 * `loading` and `error` say which.
 */
export function useBoardsNamedBy(record: Launch["record"] | null) {
  const projects = useMemo(
    () => (record ? [boardProject(record)] : []),
    [record],
  );
  const { query, boards } = useNamedBoards(projects);
  return {
    boards: boards ?? NO_BOARDS,
    loading: query.isLoading,
    error: query.error,
    retry: () => void query.refetch(),
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
  return useCallback(
    async (launch: Launch, ids: readonly string[]): Promise<number> => {
      const dropped = await nameBoardsInRecord(
        {
          // The project's own record, read by who published it and its id: the list of every project is cut at its
          // newest records, and an older project is not in it while it is still on the server.
          readLatest: async () => {
            const latest = await fetchOwnRecord(
              launch.record.author,
              launch.record.id,
            );
            if (!latest)
              throw new Error(
                "Couldn't find this project's saved record. Reload the page and try again.",
              );
            return latest;
          },
          boardsAmong: async (named) =>
            new Set(
              (await readNamedBoards(readServer, named)).map((board) =>
                board.id.toLowerCase(),
              ),
            ),
          save: async (record, channels) => {
            await save.mutateAsync(recordToInput(record, { channels }));
          },
        },
        ids,
      );
      void client.invalidateQueries({ queryKey: boardOwnersQueryKey });
      return dropped;
    },
    [client, save],
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
 * Make the project's supporters and founders boards inside it. `boards` are the project's boards, or null when they are
 * not known (`knownBoards`); only the missing ones are made, and none at all from null. `create` resolves with how many of the founder's other picked channels no longer fit in the
 * record (0 when all did), or null when it stopped on a problem, which `state` then says.
 */
export function useProjectStarterBoards(
  launch: Launch,
  boards: readonly { name: string; description: string }[] | null,
) {
  const client = useQueryClient();
  const name = useNameBoards();
  const [state, setState] = useState<StarterState>({ phase: "idle" });

  const create = useCallback(async (): Promise<number | null> => {
    setState({ phase: "working" });
    const publisher = openUserPublisher();
    let dropped = 0;
    let outcome: StarterState = { phase: "idle" };
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
    } catch (error) {
      outcome = {
        phase: "error",
        message: failureWords(error, "Couldn't set up the boards. Try again.")
          .text,
      };
    } finally {
      publisher.close();
      await client.invalidateQueries({ queryKey: ["channels"] });
      await client.invalidateQueries({ queryKey: boardOwnersQueryKey });
      await client.invalidateQueries({ queryKey: launchesQueryKey });
    }
    // Only now, with the lists read again: until then the page still holds the boards as they were before this run,
    // and a second press would make from that old list.
    setState(outcome);
    return outcome.phase === "idle" ? dropped : null;
  }, [launch, boards, client, name]);

  return { state, create };
}
