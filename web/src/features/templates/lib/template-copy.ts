/**
 * How the project templates are described to a person choosing one. Alias-free;
 * `template-copy.test.mjs` drives it under `node --test`.
 *
 * The templates come from the command line's world, where a helper is an
 * "agent" and a document is a "doc". Here they are helpers and pages, and each
 * one says who it is for, because the people choosing are filmmakers,
 * musicians and founders, not people who know what an agent runtime is.
 */

import type {
  TemplateBudget,
  TemplateSummary,
} from "@creaton/core/templates/schema.ts";

import { raisesOffered } from "../../launchpad/lib/raises-offered.ts";

/** What a template is called in the picker (the file's own name, where it is already plain). */
const TITLES: Record<string, string> = {
  "vanilla-app-studio": "Web & App Studio",
};

/** Who each bundled template is for. A template without a line here simply has none. */
const AUDIENCE: Record<string, string> = {
  "ai-media-studio":
    "For filmmakers, musicians and audio storytellers making things with AI.",
  "ai-app-studio": "For people building products powered by AI.",
  "crypto-app-studio": "For contracts, protocols and onchain apps.",
  "vanilla-app-studio": "For any web or app startup, without the ceremony.",
};

type Preset = { id: string; title: string; blurb: string };

/**
 * The two starting points shown first, in the words a newcomer would use for what they are making. They stand in for the
 * bundled teams that fit most people; every other team sits under "More kinds of team". A contributor-only build sets up
 * no AI helpers (its server runs no AI service), so there the lines leave them out.
 */
export function presetsFor(helpers: boolean): readonly Preset[] {
  return [
    {
      id: "ai-media-studio",
      title: "Creative project",
      blurb: helpers
        ? "Film, music, audio or any creative work, made with AI helpers."
        : "Film, music, audio or any creative work.",
    },
    {
      id: "vanilla-app-studio",
      title: "Technical project",
      blurb: helpers
        ? "A web or app product, with a builder, a reviewer and a lead."
        : "A web or app product.",
    },
  ];
}

/** The starting points this build shows. */
export const PRESETS: readonly Preset[] = presetsFor(raisesOffered());

export function templatePreset(
  id: string,
): { id: string; title: string; blurb: string } | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

export function templateTitle(
  summary: Pick<TemplateSummary, "id" | "name">,
): string {
  return TITLES[summary.id] ?? summary.name;
}

export function templateAudience(id: string): string | null {
  return AUDIENCE[id] ?? null;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "4 rooms · 6 AI helpers · 3 shared pages", leaving out what a template does not have. A contributor-only build
 * (`helpers` false) never sets helpers up, so it does not count them.
 */
export function templateCounts(
  summary: Pick<TemplateSummary, "channels" | "helpers" | "pages">,
  helpers: boolean = raisesOffered(),
): string {
  const boards = summary.channels.filter((channel) => channel.board).length;
  const parts = [count(summary.channels.length - boards, "room", "rooms")];
  if (boards > 0) parts.push(count(boards, "board", "boards"));
  if (helpers && summary.helpers.length > 0) {
    parts.push(count(summary.helpers.length, "AI helper", "AI helpers"));
  }
  if (summary.pages.length > 0) {
    parts.push(count(summary.pages.length, "shared page", "shared pages"));
  }
  return parts.join(" · ");
}

const WINDOWS: Record<string, string> = {
  epoch: "in total",
  day: "a day",
  week: "a week",
  month: "a month",
};

/** The default limit in words, or null when the template sets none. */
export function describeDefaultLimit(
  budget: TemplateBudget | null | undefined,
): string | null {
  if (!budget) return null;
  const window = WINDOWS[budget.window ?? "day"] ?? "a day";
  const parts: string[] = [];
  if (budget.runs !== undefined) parts.push(`run ${budget.runs} times`);
  if (budget.tasks_create !== undefined) {
    parts.push(`start ${budget.tasks_create} tasks`);
  }
  if (budget.messages !== undefined) {
    parts.push(`send ${budget.messages} messages`);
  }
  if (budget.llm_calls !== undefined) {
    parts.push(`make ${budget.llm_calls} AI requests`);
  }
  if (parts.length === 0) return null;
  const last = parts.pop() as string;
  const list = parts.length > 0 ? `${parts.join(", ")} and ${last}` : last;
  return `Each helper can ${list} ${window}. Past that, it asks you first.`;
}
