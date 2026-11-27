/**
 * A project as the new app shows it, read from its record (kind 37001). A thin reader on purpose: only the fields
 * the Project page and Home use. The record's other tags (money, chain, channels) are carried untouched whenever the
 * founder republishes it (`recordWithTeam`), so nothing written by web/ is lost.
 */
import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import {
  type FormerMember,
  parseFormerTeam,
  parseTeam,
  type TeamMember,
  teamTags,
} from "@creaton/core/project/team.ts";

export interface RecordEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface Project {
  id: string;
  author: string;
  coordinate: string;
  name: string;
  pitch: string;
  image: string | null;
  /** When the project was first published (seconds). */
  startedAt: number;
  /** When this version of the record was signed. */
  updatedAt: number;
  topics: string[];
  team: TeamMember[];
  formerTeam: FormerMember[];
  unlisted: boolean;
  event: RecordEvent;
}

const HEX64 = /^[0-9a-f]{64}$/;

function tagValue(tags: readonly string[][], name: string): string | null {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A project from its record, or null when the record is not one (no id, no name, a malformed author). */
export function parseProject(event: RecordEvent): Project | null {
  if (event.kind !== KIND_LAUNCH_RECORD || !HEX64.test(event.pubkey))
    return null;
  const id = tagValue(event.tags, "d");
  const name = tagValue(event.tags, "name");
  if (!id || !name) return null;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content || "{}");
    if (parsed && typeof parsed === "object")
      body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const started =
    typeof body.started === "number" && body.started > 0
      ? Math.min(Math.floor(body.started), event.created_at)
      : event.created_at;
  const image =
    typeof body.image === "string" && /^https:\/\//.test(body.image)
      ? body.image
      : null;
  return {
    id,
    author: event.pubkey,
    coordinate: projectCoordinate(event.pubkey, id),
    name: name.trim(),
    pitch: typeof body.pitch === "string" ? body.pitch.trim() : "",
    image,
    startedAt: started,
    updatedAt: event.created_at,
    topics: event.tags
      .filter((tag) => tag[0] === "t" && tag[1] && tag[1] !== "dao-launchpad")
      .map((tag) => tag[1].toLowerCase()),
    team: parseTeam(event.tags, event.pubkey),
    formerTeam: parseFormerTeam(event.tags),
    unlisted: body.listing === "unlisted",
    event,
  };
}

/** The address of a project's record, which its updates and posts name in an `a` tag. */
export function projectCoordinate(author: string, id: string): string {
  return `${KIND_LAUNCH_RECORD}:${author}:${id}`;
}

/** The project's link, the same shape web/ shares (`/p/<id>-<first 16 of the founder>`), so old links keep working. */
export function projectPath(project: Pick<Project, "id" | "author">): string {
  return `/p/${projectRef(project)}`;
}

/** The part of a project's link after `/p/`. */
export function projectRef(project: Pick<Project, "id" | "author">): string {
  return `${project.id}-${project.author.slice(0, 16)}`;
}

/** The id and the founder's first 16 characters from a project link, or null when it is not one. */
export function parseProjectRef(
  ref: string,
): { id: string; founderPrefix: string } | null {
  const match = /^(.+)-([0-9a-f]{16})$/.exec(ref);
  if (!match) return null;
  return { id: match[1], founderPrefix: match[2] };
}

/** Newest version per project (an id is per founder), newest first. */
export function latestProjects(events: readonly RecordEvent[]): Project[] {
  const byCoordinate = new Map<string, Project>();
  for (const event of events) {
    const project = parseProject(event);
    if (!project) continue;
    const was = byCoordinate.get(project.coordinate);
    if (!was || project.updatedAt > was.updatedAt)
      byCoordinate.set(project.coordinate, project);
  }
  return [...byCoordinate.values()].sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || (a.coordinate < b.coordinate ? -1 : 1),
  );
}

/** Tags only the team code writes; every other tag of the record is carried as it is. */
const TEAM_TAG_NAMES = new Set(["team", "team-invite", "team-left", "p"]);

/**
 * The founder's record with a new team, ready to sign: same id, same content, every other tag kept, and signed later
 * than the version it replaces (two saves in one second would otherwise tie).
 */
export function recordWithTeam(
  project: Project,
  team: readonly TeamMember[],
  formerTeam: readonly FormerMember[],
  now: number = Math.floor(Date.now() / 1000),
): { kind: number; tags: string[][]; content: string; created_at: number } {
  const kept = project.event.tags.filter((tag) => !TEAM_TAG_NAMES.has(tag[0]));
  return {
    kind: KIND_LAUNCH_RECORD,
    tags: [...kept, ...teamTags(team, formerTeam)],
    content: project.event.content,
    created_at: Math.max(now, project.updatedAt + 1),
  };
}

/** A project id from its name: lower case words joined by dashes, as web/'s Start makes it. */
export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
