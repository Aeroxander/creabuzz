/**
 * The chips of Discover's category browse: the fixed set Start offers (`launchpad/lib/categories.ts`), always shown, and
 * after them any other topic a project carries.
 *
 * Always shown, because a picker that hides a kind of project until enough of them exist cannot be used to find the
 * first one. A chip for a kind nobody has filed yet leads to an honest "nothing filed yet", not to a missing chip.
 * "AI agent or tool" also lists projects tagged with the older topic "AI agents", so an earlier project is not lost
 * when the name changed.
 *
 * Pure and alias-free: `category-chips.test.mjs` drives it under `node --test`.
 */

import { START_CATEGORIES } from "../../launchpad/lib/categories.ts";
import { buildCategoryQuery, categoryLabel } from "./categories.ts";

/** Older topics that name the same kind of project as a fixed chip, by the chip's id. */
const OLDER_TOPICS: Readonly<Record<string, readonly string[]>> = {
  "ai agent or tool": ["ai agents"],
};

export interface CategoryChip {
  /** The chip's lower-case name; it is also the topic a record written by Start carries. */
  id: string;
  label: string;
  /** Every topic tag this chip lists. */
  topics: readonly string[];
}

/** The last fixed chip: a catch-all reads best after the topics people actually use. */
const LAST = "other";

function fixedChip(label: string): CategoryChip {
  const id = label.toLowerCase();
  return { id, label, topics: [id, ...(OLDER_TOPICS[id] ?? [])] };
}

/**
 * The chips to show, given the topics found on listed projects: the fixed set in Start's order, the other topics found
 * (sorted, so the row does not shuffle), and "Other" last. A found topic a fixed chip already lists adds no second chip.
 */
export function categoryChips(found: readonly string[]): CategoryChip[] {
  const fixed = START_CATEGORIES.map(fixedChip);
  const covered = new Set(fixed.flatMap((chip) => chip.topics));
  const extra = [...new Set(found.map((topic) => topic.trim().toLowerCase()))]
    .filter((topic) => topic !== "" && !covered.has(topic))
    .sort()
    .map(
      (topic): CategoryChip => ({
        id: topic,
        label: categoryLabel(topic),
        topics: [topic],
      }),
    );
  return [
    ...fixed.filter((chip) => chip.id !== LAST),
    ...extra,
    ...fixed.filter((chip) => chip.id === LAST),
  ];
}

/** One page of a chip's projects: the bounded, explicit-kind query of `buildCategoryQuery`, over all of the chip's topics. */
export function chipQuery(chip: CategoryChip, until: number | null) {
  return {
    ...buildCategoryQuery({ category: null, until }),
    "#t": [...chip.topics],
  };
}

/** A test id and key that is safe to read: "AI agent or tool" is `ai-agent-or-tool`. */
export function chipSlug(chip: CategoryChip): string {
  return chip.id.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
