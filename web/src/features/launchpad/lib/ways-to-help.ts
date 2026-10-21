/**
 * Ways to help (the contributor plan's F1, built on what earns Shares): the work areas open for submissions now, each
 * with what finished work looks like, so a newcomer can find work and submit it without being told the words.
 *
 * A work area's words are on the chain only as a hash (`projects(id).checkHash`), and a submission must state them
 * exactly or its manager cannot accept it. So the words come from what was published beside the chain: the project's
 * record (its first work areas), the update posted when a work area was put to a vote, the suggestion it came from, and
 * the evidence of work already submitted in it. Whoever published them, they are shown only when they hash to the
 * work area's check; otherwise the page says the words are not published and who to ask.
 *
 * Pure and alias-free: `ways-to-help.test.mjs` drives it under `node --test`.
 */

import { hashText, idLabel, idWord } from "@creaton/core/launchpad/work.ts";

/** Somewhere a work area's words were published. `mandate` and `id` narrow it to one work area when known. */
export interface WordsSource {
  text: string;
  mandate?: string;
  id?: string;
}

const same = (a: string | undefined, b: string) =>
  a === undefined || a.toLowerCase() === b.toLowerCase();

/** The words that hash to a work area's check, from the first source that names it (or none) and matches; or null. */
export function wordsFor(
  area: { mandate: string; id: string; checkHash: string },
  sources: readonly WordsSource[],
): string | null {
  const want = area.checkHash.toLowerCase();
  for (const source of sources) {
    if (!same(source.mandate, area.mandate) || !same(source.id, area.id))
      continue;
    // `hashText` hashes the words without the spaces around them, as every form that sets a check does.
    const text = source.text.trim();
    if (text !== "" && hashText(text) === want) return text;
  }
  return null;
}

/** The first work areas' words in a project's record, as sources (a record names work areas by name, not budget). */
export function recordSources(
  workAreas: readonly { name: string; check: string }[],
): WordsSource[] {
  return workAreas.flatMap((area) => {
    try {
      return [{ text: area.check, id: idWord(area.name) }];
    } catch {
      return [];
    }
  });
}

export interface OpenWorkArea {
  mandate: string;
  id: string;
  name: string;
  manager: string;
  /** Shares it may still award (18 decimals). */
  sharesLeft: bigint;
  /** Money it may still reserve (the budget's currency units), when it holds money. */
  moneyLeft: bigint;
  expiresAt: number;
  /** The hash its submissions must state (lower-case), read from the chain. */
  checkHash: string;
  /** What finished work looks like, verified against the chain; null when nobody published words that match. */
  words: string | null;
}

/** The shape of the work read this needs (structural, so the snapshot type fits). */
export interface WorkForHelp {
  chainTime: number;
  mandates: readonly {
    address: string;
    closed: boolean;
    isMilestonePanel: boolean;
    expiresAt: number;
    projects: readonly {
      id: string;
      record: {
        manager: string;
        budget: bigint;
        reserved: bigint;
        expiresAt: number;
        checkHash: string;
        shareBudget: bigint;
        sharesAwarded: bigint;
      };
    }[];
  }[];
}

/**
 * The work areas someone could submit work in right now: in an open budget that is not the milestone panel, not past
 * their end, and with Shares or money left to give. Soonest to close first.
 */
export function openWorkAreas(
  work: WorkForHelp,
  sources: readonly WordsSource[],
): OpenWorkArea[] {
  const now = work.chainTime;
  return work.mandates
    .filter((m) => !m.closed && !m.isMilestonePanel && m.expiresAt > now)
    .flatMap((mandate) =>
      mandate.projects.flatMap((project) => {
        const { record } = project;
        const sharesLeft = record.shareBudget - record.sharesAwarded;
        const moneyLeft = record.budget - record.reserved;
        if (record.expiresAt <= now || (sharesLeft <= 0n && moneyLeft <= 0n))
          return [];
        return [
          {
            mandate: mandate.address.toLowerCase(),
            id: project.id.toLowerCase(),
            name: idLabel(project.id),
            manager: record.manager,
            sharesLeft: sharesLeft > 0n ? sharesLeft : 0n,
            moneyLeft: moneyLeft > 0n ? moneyLeft : 0n,
            expiresAt: record.expiresAt,
            checkHash: record.checkHash.toLowerCase(),
            words: wordsFor(
              {
                mandate: mandate.address,
                id: project.id,
                checkHash: record.checkHash,
              },
              sources,
            ),
          },
        ];
      }),
    )
    .sort((a, b) => a.expiresAt - b.expiresAt || a.name.localeCompare(b.name));
}

/** A work area as the submit form knows it. */
type FormArea = Pick<
  OpenWorkArea,
  "mandate" | "id" | "name" | "words" | "checkHash"
>;

const draftKey = (area: Pick<OpenWorkArea, "mandate" | "id">) =>
  `${area.mandate.toLowerCase()}:${area.id.toLowerCase()}`;

/**
 * The words the submit form shows after moving from one work area to another. What was typed for the area being left
 * is kept for it in `drafts`; the new area shows its own published words, else what was typed for it before, else
 * nothing. One area's words never carry over into another's. Moving to "not sure yet" (`to` null) keeps the text.
 */
export function wordsAfterMove(
  drafts: Map<string, string>,
  from: Pick<OpenWorkArea, "mandate" | "id"> | null,
  typed: string,
  to: FormArea | null,
): string {
  if (from) drafts.set(draftKey(from), typed);
  if (!to) return typed;
  return to.words ?? drafts.get(draftKey(to)) ?? "";
}

/** Why these words cannot be submitted for the chosen work area, read from its hash now; or null when they can. */
export function wordsProblem(
  area: FormArea | null,
  words: string,
): string | null {
  if (!area || hashText(words) === area.checkHash.toLowerCase()) return null;
  return area.words
    ? `These are not ${area.name}'s exact words, so its manager could not accept your work. Use the words shown under Ways to help.`
    : `These are not ${area.name}'s words as it was approved, so its manager could not accept your work. Ask its manager for the exact words.`;
}

/** The update that publishes a work area's words beside the vote that approves it. */
export function workAreaUpdateContent(input: {
  mandate: string;
  id: string;
  check: string;
}): Record<string, unknown> {
  return {
    title: `Work area: ${idLabel(input.id)}`,
    body: `What finished work looks like: ${input.check}`,
    links: [],
    workArea: {
      id: input.id.toLowerCase(),
      mandate: input.mandate.toLowerCase(),
      check: input.check,
    },
  };
}
