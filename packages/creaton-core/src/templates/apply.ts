/**
 * Turning a template into records: which steps to take, and the exact event
 * each step publishes.
 *
 * The plan and the markers follow the command line's engine
 * (`crates/buzz-cli/src/commands/templates/apply.rs`) so the two interoperate:
 * every record a template writes carries a marker tag
 * `["t", <template id>, <item id>]`, and applying again (or resuming after a
 * failure) skips every item whose marker is already on the server. Steps run in
 * a fixed order and stop at the first failure, so what exists afterwards is
 * always a consistent prefix of the plan.
 *
 * Two deliberate differences from the command line, because this runs in a
 * browser:
 *
 * - A skill whose source is a web address is not fetched (a page cannot read
 *   other sites, and a pinned fetch must be reproducible); the plan marks it
 *   `needs-cli` and the command line finishes it.
 * - A document becomes a page of the community's wiki (kind 44001, where people
 *   and helpers read), not a long-form note.
 *
 * Pure: the caller supplies the clock, the id generator and what the server
 * already holds, and signs and sends each drafted event itself.
 */

import {
  KIND_PERSONA,
  KIND_SKILL,
  KIND_WIKI_PAGE,
  KIND_WORKFLOW_DEF,
} from "../kinds.generated.ts";
import {
  docSlug,
  isBoardChannel,
  isPrivateChannel,
  isRemoteSkill,
  ORG_DEFAULT_BUDGET_ID,
  ORG_ROOT_NODE_ID,
  seatNodeId,
  type TemplateEntry,
} from "./schema.ts";

const KIND_CREATE_CHANNEL = 9007;
const KIND_CHANNEL_MESSAGE = 9;
/** A post on a board (the server's forum post). */
const KIND_BOARD_POST = 45001;
const KIND_ORG_NODE = 37010;
const KIND_ORG_BUDGET = 37012;

/** What a step writes. */
export type StepKind =
  | "channel"
  | "seed"
  | "skill"
  | "persona"
  | "org"
  | "workflow"
  | "doc"
  | "welcome";

/**
 * What a step will do:
 * - `create`: write it;
 * - `already-exists` / `unchanged`: the server already has it, skip;
 * - `needs-cli`: this app cannot do it (a skill from a web address).
 */
type StepAction = "create" | "already-exists" | "unchanged" | "needs-cli";

/** One step of a plan. `item` is the marker's item id (or the template's own id for channels). */
export interface PlanStep {
  kind: StepKind;
  item: string;
  action: StepAction;
}

/** A marker-tagged record the server already holds. */
interface ExistingItem {
  eventId: string;
  createdAt: number;
  /** Skills: the source recorded when it was written. */
  source?: string;
}

/** What the server already holds for this template, gathered before planning. */
export interface ExistingState {
  /** Canonical channel name to channel id. */
  channels: Map<string, string>;
  /** Marker-matched records by {@link itemKey}. */
  items: Map<string, ExistingItem>;
  /** `d` of the signer's own org nodes. Org steps skip these, so a hand-built org is never replaced. */
  orgNodes: Set<string>;
  /** `d` of the signer's own budgets (same reasoning). */
  orgBudgets: Set<string>;
}

/** Nothing exists yet. */
export function emptyExisting(): ExistingState {
  return {
    channels: new Map(),
    items: new Map(),
    orgNodes: new Set(),
    orgBudgets: new Set(),
  };
}

/** Key of a marker-matched record in {@link ExistingState.items}. */
export function itemKey(kind: StepKind, item: string): string {
  return `${kind}\u0000${item}`;
}

/** The marker item id of a channel's first message. */
export function seedItem(channelId: string): string {
  return `seed:${channelId}`;
}

/** The marker tag every record a template writes carries. */
export function marker(templateId: string, item: string): string[] {
  return ["t", templateId, item];
}

/** Channel names compare without a leading `#` or surrounding space. */
export function canonicalChannelName(name: string): string {
  return name.trim().replace(/^#+/, "").trim();
}

/** A new `created_at` that always beats the record it replaces (replaceable records keep the newest). */
export function nextCreatedAt(now: number, prior?: number): number {
  return Math.max(now, prior === undefined ? 0 : prior + 1);
}

/** How to plan. */
export interface PlanOptions {
  /**
   * A contributor-only build (the hosted pilot): its server runs no AI
   * service, so the plan leaves out everything that only an AI helper uses:
   * skills, helpers, their seats, their limit and the automations they run.
   */
  contributorOnly?: boolean;
}

/**
 * The ordered plan. Every step is decided as create or skip from what the
 * server already holds: channels (each followed by its first message), skills,
 * helpers, the organization (founder seat, a seat per helper, the default
 * budget), workflows, documents, and the welcome.
 */
export function planApply(
  entry: TemplateEntry,
  existing: ExistingState,
  options: PlanOptions = {},
): PlanStep[] {
  const { template: t } = entry;
  const helpers = options.contributorOnly !== true;
  const steps: PlanStep[] = [];
  const has = (kind: StepKind, item: string) =>
    existing.items.has(itemKey(kind, item));
  const markerStep = (kind: StepKind, item: string) =>
    steps.push({
      kind,
      item,
      action: has(kind, item) ? "already-exists" : "create",
    });

  for (const channel of t.channels) {
    const exists = existing.channels.has(canonicalChannelName(channel.name));
    steps.push({
      kind: "channel",
      item: channel.id,
      action: exists ? "already-exists" : "create",
    });
    if (channel.seed !== undefined) markerStep("seed", seedItem(channel.id));
  }

  for (const skill of helpers ? t.skills : []) {
    const found = existing.items.get(itemKey("skill", skill.name));
    let action: StepAction;
    if (found !== undefined && found.source === skill.source) {
      action = "unchanged";
    } else if (isRemoteSkill(skill)) {
      action = "needs-cli";
    } else {
      action = "create";
    }
    steps.push({ kind: "skill", item: skill.name, action });
  }

  for (const persona of helpers ? t.personas : [])
    markerStep("persona", persona.id);

  if (t.org) {
    const orgStep = (item: string, exists: boolean) =>
      steps.push({
        kind: "org",
        item,
        action: exists ? "already-exists" : "create",
      });
    orgStep("org:root", existing.orgNodes.has(ORG_ROOT_NODE_ID));
    for (const seat of helpers ? t.org.seats : []) {
      orgStep(
        `org:seat:${seat.persona}`,
        existing.orgNodes.has(seatNodeId(seat.persona)),
      );
    }
    if (helpers && t.org.default_budget) {
      orgStep("org:budget", existing.orgBudgets.has(ORG_DEFAULT_BUDGET_ID));
    }
  }

  for (const workflow of helpers ? t.workflows : [])
    markerStep("workflow", workflow.file);
  for (const doc of t.docs) markerStep("doc", doc.file);
  markerStep("welcome", "welcome");
  return steps;
}

/** One step in words a person would use: "Create #writers-room", "Helper: The Writer". */
export function describeStep(entry: TemplateEntry, step: PlanStep): string {
  const t = entry.template;
  switch (step.kind) {
    case "channel": {
      const channel = t.channels.find((c) => c.id === step.item);
      const name = canonicalChannelName(channel?.name ?? step.item);
      return channel && isBoardChannel(channel)
        ? `Create the ${name} board`
        : `Create #${name}`;
    }
    case "seed": {
      const id = step.item.replace(/^seed:/, "");
      const channel = t.channels.find((c) => c.id === id);
      const name = canonicalChannelName(channel?.name ?? id);
      return channel && isBoardChannel(channel)
        ? `First post on the ${name} board`
        : `First message in #${name}`;
    }
    case "skill":
      return `Skill: ${step.item}`;
    case "persona":
      return `Helper: ${t.personas.find((p) => p.id === step.item)?.name ?? step.item}`;
    case "org": {
      if (step.item === "org:root") {
        return `Your team: ${t.org?.root.name ?? "team"}`;
      }
      if (step.item === "org:budget") return "A default limit for helpers";
      const id = step.item.replace(/^org:seat:/, "");
      return `Seat for ${t.personas.find((p) => p.id === id)?.name ?? id}`;
    }
    case "workflow": {
      const name = (step.item.split("/").pop() ?? step.item).replace(
        /\.ya?ml$/,
        "",
      );
      return `Automation: ${name.replace(/-/g, " ")}`;
    }
    case "doc":
      return `Page: ${t.docs.find((d) => d.file === step.item)?.title ?? step.item}`;
    case "welcome":
      return "Welcome message";
  }
}

/** A record to sign and send. */
export interface EventDraft {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

/** What building a step needs to know. */
export interface BuildContext {
  entry: TemplateEntry;
  /** Template channel id to the server's channel id, for every channel that exists or was just made. */
  channelIds: Record<string, string>;
  /** The signer (the founder seat's holder), 64-hex. */
  me: string;
  /** Unix seconds. */
  now: number;
  /** `created_at` of the record this one replaces, if any. */
  prior?: number;
  /** A fresh uuid. */
  newId: () => string;
}

function channelFor(ctx: BuildContext, id: string): string {
  const found = ctx.channelIds[id];
  if (found === undefined) throw new Error(`channel ${id} was not created`);
  return found;
}

function fileFor(entry: TemplateEntry, path: string, what: string): string {
  const text = entry.files[path];
  if (text === undefined) throw new Error(`${what} file ${path} is missing`);
  return text;
}

/** The organization step's record, with the exact content the command line writes. */
function buildOrgEvent(
  step: PlanStep,
  ctx: BuildContext,
  ts: number,
): EventDraft {
  const { entry } = ctx;
  const t = entry.template;
  const org = t.org;
  if (!org) throw new Error("this template has no organization");
  const mark = marker(t.id, step.item);

  if (step.item === "org:root") {
    return {
      kind: KIND_ORG_NODE,
      created_at: ts,
      content: JSON.stringify({
        v: 1,
        name: org.root.name,
        kind: "role",
        holders: [ctx.me],
        agentSeats: [],
        scope: {
          readBelow: true,
          assignBelow: true,
          canGrant: ["read", "task"],
        },
        ...(org.root.blurb ? { ui: { blurb: org.root.blurb } } : {}),
      }),
      tags: [
        ["d", ORG_ROOT_NODE_ID],
        ["name", org.root.name],
        ["seat", ctx.me],
        mark,
      ],
    };
  }

  const seatPersona = step.item.startsWith("org:seat:")
    ? step.item.slice("org:seat:".length)
    : null;
  if (seatPersona !== null) {
    const seat = org.seats.find((s) => s.persona === seatPersona);
    const persona = t.personas.find((p) => p.id === seatPersona);
    if (!seat || !persona) {
      throw new Error(`org seat names unknown helper ${seatPersona}`);
    }
    const name = seat.title ?? persona.name;
    return {
      kind: KIND_ORG_NODE,
      created_at: ts,
      content: JSON.stringify({
        v: 1,
        name,
        kind: "agent_seat",
        parent: ORG_ROOT_NODE_ID,
        holders: [],
        agentSeats: [],
        scope: { readBelow: false, assignBelow: false, canGrant: [] },
      }),
      tags: [["d", seatNodeId(seatPersona)], ["name", name], mark],
    };
  }

  if (step.item === "org:budget" && org.default_budget) {
    const b = org.default_budget;
    const limits: Record<string, unknown> = {};
    if (b.runs !== undefined) limits.runs = b.runs;
    if (b.tasks_create !== undefined) limits.tasks = { create: b.tasks_create };
    if (b.messages !== undefined) limits.messages = b.messages;
    if (b.llm_calls !== undefined) limits.llmCalls = b.llm_calls;
    return {
      kind: KIND_ORG_BUDGET,
      created_at: ts,
      content: JSON.stringify({
        v: 1,
        subject: "*",
        window: b.window ?? "day",
        limits,
        onExceed: "require-approval",
      }),
      tags: [["d", ORG_DEFAULT_BUDGET_ID], mark],
    };
  }
  throw new Error(`unknown organization step ${step.item}`);
}

/**
 * The record one step publishes. Throws when the template is inconsistent
 * (a missing file, a channel that was never created), naming what is wrong, so
 * a bad template fails loudly rather than writing something half-formed.
 */
export function buildStepEvent(step: PlanStep, ctx: BuildContext): EventDraft {
  const { entry } = ctx;
  const t = entry.template;
  const ts = nextCreatedAt(ctx.now, ctx.prior);
  const mark = marker(t.id, step.item);

  switch (step.kind) {
    case "channel": {
      const channel = t.channels.find((c) => c.id === step.item);
      if (!channel) throw new Error(`no channel ${step.item}`);
      return {
        kind: KIND_CREATE_CHANNEL,
        created_at: ts,
        content: "",
        tags: [
          ["h", ctx.newId()],
          ["name", canonicalChannelName(channel.name)],
          ["visibility", isPrivateChannel(channel) ? "private" : "open"],
          ["channel_type", isBoardChannel(channel) ? "forum" : "stream"],
          ["about", channel.purpose],
        ],
      };
    }
    case "seed": {
      const id = step.item.replace(/^seed:/, "");
      const channel = t.channels.find((c) => c.id === id);
      if (!channel?.seed) throw new Error(`channel ${id} has no first message`);
      return {
        // A board's first item is a post; a chat's is a message.
        kind: isBoardChannel(channel) ? KIND_BOARD_POST : KIND_CHANNEL_MESSAGE,
        created_at: ts,
        content: fileFor(entry, channel.seed, "first message"),
        tags: [["h", channelFor(ctx, id)], mark],
      };
    }
    case "welcome": {
      const first = t.channels[0];
      if (!first) throw new Error("template has no channels");
      return {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: ts,
        content: fileFor(entry, t.welcome, "welcome"),
        tags: [["h", channelFor(ctx, first.id)], mark],
      };
    }
    case "skill": {
      const skill = t.skills.find((s) => s.name === step.item);
      const resolved = entry.skills[step.item];
      if (!skill) throw new Error(`no skill ${step.item}`);
      if (!resolved) throw new Error(`skill ${step.item} is not bundled`);
      return {
        kind: KIND_SKILL,
        created_at: ts,
        content: JSON.stringify({
          name: resolved.name,
          description: resolved.description,
          sha256: resolved.sha256,
          content: resolved.content,
          attachments: [],
        }),
        tags: [
          ["d", skill.name],
          mark,
          ["sha256", resolved.sha256],
          ["source", skill.source],
          ["applies_to", skill.applies_to],
        ],
      };
    }
    case "persona": {
      const persona = t.personas.find((p) => p.id === step.item);
      if (!persona) throw new Error(`no helper ${step.item}`);
      // Only skills this app publishes are bound: a binding must never point at
      // a skill that is not on the server.
      const wanted =
        persona.skills === undefined
          ? t.skills
          : persona.skills.map((name) => {
              const found = t.skills.find((s) => s.name === name);
              if (!found) {
                throw new Error(
                  `helper ${persona.id} names unknown skill ${name}`,
                );
              }
              return found;
            });
      const bound = wanted.filter((s) => entry.skills[s.name] !== undefined);
      return {
        kind: KIND_PERSONA,
        created_at: ts,
        content: JSON.stringify({
          display_name: persona.name,
          system_prompt: fileFor(entry, persona.prompt, "helper prompt"),
        }),
        tags: [
          ["d", persona.id],
          ...bound.map((s) => ["skill", s.name, s.applies_to]),
          mark,
        ],
      };
    }
    case "workflow": {
      const workflow = t.workflows.find((w) => w.file === step.item);
      if (!workflow) throw new Error(`no workflow ${step.item}`);
      const channelId =
        workflow.channel ??
        t.channels[0]?.id ??
        (() => {
          throw new Error("template has no channels");
        })();
      return {
        kind: KIND_WORKFLOW_DEF,
        created_at: ts,
        content: fileFor(entry, workflow.file, "workflow"),
        tags: [["d", ctx.newId()], ["h", channelFor(ctx, channelId)], mark],
      };
    }
    case "doc": {
      const doc = t.docs.find((d) => d.file === step.item);
      if (!doc) throw new Error(`no document ${step.item}`);
      const slug = docSlug(doc.file);
      if (slug === null) throw new Error(`document ${doc.file} has no name`);
      return {
        kind: KIND_WIKI_PAGE,
        created_at: ts,
        content: fileFor(entry, doc.file, "document"),
        tags: [["d", slug], mark],
      };
    }
    case "org":
      return buildOrgEvent(step, ctx, ts);
  }
}

/** The channel id a created channel's draft carries (its `h` tag). */
export function channelIdOf(draft: EventDraft): string {
  const found = draft.tags.find((tag) => tag[0] === "h")?.[1];
  if (!found) throw new Error("channel record has no id");
  return found;
}

/** The marker item of a record that carries this template's marker, or null. */
export function markerItem(
  tags: readonly (readonly string[])[],
  templateId: string,
): string | null {
  for (const tag of tags) {
    if (tag[0] === "t" && tag[1] === templateId && typeof tag[2] === "string") {
      return tag[2];
    }
  }
  return null;
}
