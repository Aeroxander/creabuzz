/**
 * "Part of": a community task pointing at a work area of one of this community's contributor projects.
 *
 * The link is a reference only. Finishing the task awards nothing: Shares come from taking the work area on and
 * submitting the work on the project's Work tab, where its manager accepts it. The task keeps the link in its `partOf`
 * field (a sticky field, see `TASK_STICKY_FIELDS`, so a row that leaves it out cannot erase it; unlinking writes an
 * explicit null) and is indexed by the project's `a` tag, the tag a delivery link already uses.
 *
 * Only ids are stored. What people read is derived from them: the project's name from this community's own launch
 * list, the work area's title from its id on the chain, so a task row cannot put words in a project's mouth.
 *
 * Pure and alias-free: `task-part-of.test.mjs` drives it under `node --test`.
 */

import { parseLaunchCoordinate } from "../../feed/lib/feed-events.ts";
import {
  openWorkAreas,
  type WorkForHelp,
} from "../../launchpad/lib/ways-to-help.ts";

export interface TaskPartOf {
  /** The project's launch coordinate, `37001:<author>:<d>`. */
  project: string;
  /** The budget the work area is in (lower case). */
  mandate: string;
  /** The work area's id on the chain (lower case). */
  area: string;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;

/** A well-formed link, or null (an old task without one, or anything malformed). */
export function readPartOf(value: unknown): TaskPartOf | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const raw = value as Record<string, unknown>;
  const project = typeof raw.project === "string" ? raw.project : "";
  const mandate =
    typeof raw.mandate === "string" ? raw.mandate.toLowerCase() : "";
  const area = typeof raw.area === "string" ? raw.area.toLowerCase() : "";
  if (!parseLaunchCoordinate(project) || !ADDRESS.test(mandate)) return null;
  if (!WORD.test(area)) return null;
  return { project, mandate, area };
}

/** The row's tags with the project's `a` tag added when the task is linked (once, whoever added it first). */
export function taskPartOfTags(tags: string[][], value: unknown): string[][] {
  const link = readPartOf(value);
  return link && !tags.some((t) => t[0] === "a" && t[1] === link.project)
    ? [...tags, ["a", link.project]]
    : tags;
}

/** A link as one picker value. */
export function partOfKey(link: TaskPartOf): string {
  return `${link.project}|${link.mandate}|${link.area}`;
}

/** The link a picker value names, or null for "not part of a project". */
export function partOfFromKey(key: string): TaskPartOf | null {
  const [project, mandate, area, ...rest] = key.split("|");
  if (rest.length > 0) return null;
  return readPartOf({ project, mandate, area });
}

export interface PartOfChoice {
  coordinate: string;
  name: string;
  areas: { link: TaskPartOf; title: string }[];
}

/**
 * What the "Part of" picker offers: each contributor project's work areas open for submissions now (the Work tab's
 * own rule, `openWorkAreas`), by the title the Work tab shows (`titles`, the project's published titles, keyed as
 * `knownTitles` keys them; the short name made readable when none is published). A project whose work could not be
 * read, or that has no open area, is left out.
 */
export function partOfChoices(
  projects: readonly {
    coordinate: string;
    name: string;
    work: WorkForHelp | undefined;
    titles?: ReadonlyMap<string, string>;
  }[],
): PartOfChoice[] {
  return projects.flatMap((project) => {
    if (!project.work) return [];
    const areas = openWorkAreas(project.work, [], project.titles).map(
      (area) => ({
        link: {
          project: project.coordinate,
          mandate: area.mandate,
          area: area.id,
        },
        title: area.title,
      }),
    );
    return areas.length > 0
      ? [{ coordinate: project.coordinate, name: project.name, areas }]
      : [];
  });
}

/**
 * The picker value to show and to write: `key` while it names an area still offered, else none. A choice whose area
 * stopped being open is dropped instead of being written behind a picker that no longer shows it.
 */
export function offeredPartOfKey(
  choices: readonly PartOfChoice[],
  key: string,
): string {
  return choices.some((choice) =>
    choice.areas.some((area) => partOfKey(area.link) === key),
  )
    ? key
    : "";
}
