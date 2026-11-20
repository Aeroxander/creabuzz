/**
 * What demo day shows for a batch of projects (plan section 5.3): each project's record, its team's newest update, and the
 * server's numbers for it. Three reads for a batch (the records, then the updates and the numbers together), never one per
 * project. Every project is checked again here before it is listed: its record must be found and listed, launched on the
 * network, and the entry that put it in the season must have been signed by someone who speaks for the project.
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  KIND_PROJECT_NUMBERS,
} from "@creaton/core/kinds.ts";
import { isGoalRecordTags } from "@creaton/core/project/goals.ts";
import { isJoinAskTags } from "@creaton/core/project/join.ts";
import {
  isTeamAnswerTags,
  parseTeamAnswer,
  projectVoices,
  type TeamAnswer,
} from "@creaton/core/project/team.ts";
import { useQuery } from "@tanstack/react-query";
import { type NostrFilter, readMulti } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import {
  freshnessOf,
  type Freshness,
  type NumbersEvent,
  type ProjectNumbers,
} from "../money/numbers";
import { chainKeyOfProject, matchNumbers, newest } from "../money/use-money";
import { latestProjects, type Project } from "../project/project-record";
import { updateText } from "../project/use-project";
import {
  isNotAnUpdate,
  liveCoordinates,
  type SeasonEntry,
  splitCoordinate,
} from "./season-records";

/** Projects drawn at a time, with "Show more" for the next. */
export const BATCH_SIZE = 24;
/** What the server accepts in one read: 10 filters, and a longer list is asked for in parts (`nostr-client.ts`). */
const FILTERS_PER_READ = 10;
/** How many records of one project's team are read to find its newest update. */
const UPDATES_READ = 60;
/** The words of an update kept for a card: its title and the start of its body. */
const UPDATE_BODY_MAX = 160;
const UPDATE_TITLE_MAX = 80;

interface LastUpdate {
  at: number;
  title: string;
  body: string;
}

export interface DemoCardData {
  project: Project;
  /** The server's numbers for the project, or null when it has none here yet (or its launch left the network). */
  numbers: ProjectNumbers | null;
  freshness: Freshness | null;
  update: LastUpdate | null;
}

interface Record47003 {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Many filters read in parts of ten, the answers in the order the filters were given. */
async function readInParts(filters: readonly NostrFilter[]) {
  const parts: NostrFilter[][] = [];
  for (let i = 0; i < filters.length; i += FILTERS_PER_READ)
    parts.push(filters.slice(i, i + FILTERS_PER_READ));
  return (await Promise.all(parts.map((part) => readMulti(part)))).flat();
}

const cut = (text: string, max: number): string => {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
};

/** The newest update a project's team wrote, or null: a record by a voice of the project, and not an ask, an answer, a goal, or a season or room record. */
function lastUpdateOf(
  records: readonly Record47003[],
  voices: ReadonlyMap<string, number | null>,
): LastUpdate | null {
  let best: Record47003 | null = null;
  for (const event of records) {
    if (event.kind !== KIND_LAUNCH_UPDATE) continue;
    if (
      isJoinAskTags(event.tags) ||
      isTeamAnswerTags(event.tags) ||
      isGoalRecordTags(event.tags) ||
      isNotAnUpdate(event.tags)
    )
      continue;
    if (!voices.has(event.pubkey)) continue;
    const until = voices.get(event.pubkey);
    if (until !== null && until !== undefined && event.created_at > until)
      continue;
    if (
      !best ||
      event.created_at > best.created_at ||
      (event.created_at === best.created_at && event.id > best.id)
    )
      best = event;
  }
  if (!best) return null;
  const text = updateText(best.content);
  return {
    at: best.created_at,
    title: cut(text.title, UPDATE_TITLE_MAX),
    body: cut(text.body, UPDATE_BODY_MAX),
  };
}

/** The newest record of numbers per chain key, newest first, so a key with two records matches its newest. */
function newestPerKey(events: readonly NumbersEvent[]): NumbersEvent[] {
  const seen = new Set<string>();
  const out: NumbersEvent[] = [];
  for (const event of newest([...events])) {
    const d = event.tags.find((tag) => tag[0] === "d")?.[1]?.toLowerCase();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(event);
  }
  return out;
}

/**
 * The cards of one batch of coordinates, in the order given. A coordinate whose project cannot be found, is unlisted, is not
 * launched, or whose entry no voice of the project signed, has no card.
 */
async function readDemoBatch(
  coordinates: readonly string[],
  entries: readonly SeasonEntry[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<DemoCardData[]> {
  const named = coordinates.flatMap((coordinate) => {
    const who = splitCoordinate(coordinate);
    return who ? [{ coordinate, ...who }] : [];
  });
  if (named.length === 0) return [];
  const found = await readInParts(
    named.map((n) => ({
      kinds: [KIND_LAUNCH_RECORD],
      authors: [n.founder],
      "#d": [n.id],
      limit: 5,
    })),
  );
  const projects: Project[] = [];
  named.forEach((n, i) => {
    const project = latestProjects(found[i] ?? []).find(
      (p) => p.coordinate === n.coordinate,
    );
    if (project && !project.unlisted && chainKeyOfProject(project) !== null)
      projects.push(project);
  });
  if (projects.length === 0) return [];

  const signer = serverRelaySigner();
  const keys = projects.flatMap((p) => chainKeyOfProject(p) ?? []);
  const [records, numberAnswers] = await Promise.all([
    readInParts(
      projects.map((p) => ({
        kinds: [KIND_LAUNCH_UPDATE],
        "#a": [p.coordinate],
        limit: UPDATES_READ,
      })),
    ),
    investingOn() && signer && keys.length > 0
      ? readInParts(
          // The keys of one batch, ten to a filter, in one read.
          Array.from({ length: Math.ceil(keys.length / 10) }, (_, i) => ({
            kinds: [KIND_PROJECT_NUMBERS],
            authors: [signer],
            "#d": keys.slice(i * 10, i * 10 + 10),
            limit: 50,
          })),
        )
      : Promise.resolve([]),
  ]);
  const numberEvents = numberAnswers.flat();

  const voices = new Map<string, Map<string, number | null>>();
  projects.forEach((project, i) => {
    const answers = (records[i] ?? [])
      .map(parseTeamAnswer)
      .filter((a): a is TeamAnswer => a !== null);
    voices.set(project.coordinate, projectVoices(project, answers));
  });
  const speaks = (entry: SeasonEntry) => {
    const who = voices.get(entry.coordinate);
    if (!who?.has(entry.signer)) return false;
    const until = who.get(entry.signer);
    return until === null || until === undefined || entry.at <= until;
  };
  const verified = new Set(
    liveCoordinates(
      entries.filter((e) => voices.has(e.coordinate)),
      speaks,
    ),
  );

  const matched = new Map(
    matchNumbers(projects, newestPerKey(numberEvents as NumbersEvent[])).map(
      (m) => [m.project.coordinate, m.numbers],
    ),
  );
  return projects.flatMap((project, i) => {
    if (!verified.has(project.coordinate)) return [];
    const numbers = matched.get(project.coordinate) ?? null;
    return [
      {
        project,
        numbers,
        freshness: numbers ? freshnessOf(numbers, now) : null,
        update: lastUpdateOf(
          records[i] ?? [],
          voices.get(project.coordinate) ?? new Map(),
        ),
      },
    ];
  });
}

/** One batch of cards. The entries are part of the key so a changed season reads again. */
export function useDemoBatch(
  number: number,
  index: number,
  coordinates: readonly string[],
  entries: readonly SeasonEntry[],
) {
  return useQuery({
    queryKey: ["season", "demo", number, index, coordinates.join(",")],
    enabled: investingOn() && coordinates.length > 0,
    staleTime: 30_000,
    queryFn: () => readDemoBatch(coordinates, entries),
  });
}
