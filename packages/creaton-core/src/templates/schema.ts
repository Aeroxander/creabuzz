/**
 * Project templates: what a ready-made team is made of.
 *
 * A template is a folder under `templates/` (`template.yaml` plus the markdown
 * and workflow files it names): channels with a first message, helpers (a name
 * and a prompt each), shared documents, optional workflows and skills, a
 * welcome message, and the organization the project starts with (a founder
 * seat, one vacant seat per helper, and a default budget that covers every
 * helper from day one).
 *
 * The command line (`buzz templates apply`) and the web app both turn a
 * template into signed records on the server, and both mark every record
 * they write the same way, so one can finish what the other started. The
 * command line's parser is the contract
 * (`crates/buzz-cli/src/commands/templates/schema.rs`); the types and bounds
 * here follow it, and `scripts/regen-template-catalog.mjs` validates every
 * bundled template against them.
 *
 * Pure: no I/O, no framework.
 */

/** Longest `name`. */
export const MAX_NAME = 60;
/** Longest `description`, shown in the picker. */
export const MAX_DESCRIPTION = 280;
/** Longest channel `purpose`. */
export const MAX_PURPOSE = 200;
/** Channels a template may define. */
export const MAX_CHANNELS = 8;
/** Helpers (personas) a template may define. */
export const MAX_PERSONAS = 6;
/** Workflows a template may define. */
export const MAX_WORKFLOWS = 6;
/** Documents a template may define. */
export const MAX_DOCS = 8;
/** Skills a template may define. */
export const MAX_SKILLS = 8;
/** Longest founder-seat blurb. */
export const MAX_ORG_BLURB = 120;
/** Ceiling on any default-budget counter: a starting point, not a blank cheque. */
export const MAX_DEFAULT_BUDGET_LIMIT = 1_000_000;
/** Bound on every referenced text file. */
export const MAX_FILE_BYTES = 64 * 1024;

/** The org node id of the founder seat. */
export const ORG_ROOT_NODE_ID = "root";
/** The `d` of the community default budget a template writes. */
export const ORG_DEFAULT_BUDGET_ID = "default-agents";

/**
 * One channel. `seed` is a template-relative file posted as its first message,
 * or, for a board, as its first post (so it starts with a `# Title` heading).
 */
export interface TemplateChannel {
  id: string;
  name: string;
  purpose: string;
  seed?: string;
  /** `chat` (live messages, the default) or `board` (posts and replies). */
  type?: "chat" | "board";
  /** `open` (anyone in the community, the default) or `private` (only people added). */
  visibility?: "open" | "private";
}

/** A board holds posts and replies; the server calls this channel type `forum`. */
export function isBoardChannel(
  channel: Pick<TemplateChannel, "type">,
): boolean {
  return channel.type === "board";
}

/** Only people who are added can read a private channel. */
export function isPrivateChannel(
  channel: Pick<TemplateChannel, "visibility">,
): boolean {
  return channel.visibility === "private";
}

/** One helper: a name and the prompt that tells it who it is. */
export interface TemplatePersona {
  id: string;
  name: string;
  /** Template-relative file. */
  prompt: string;
  /** Skill names this helper inherits; absent means every template skill. */
  skills?: string[];
}

/** One workflow, bound to a channel (the first channel when it names none). */
export interface TemplateWorkflow {
  file: string;
  channel?: string;
}

/** One shared document. */
export interface TemplateDoc {
  file: string;
  title: string;
}

/** Who a skill is written for. Metadata, not an access boundary. */
export type SkillScope = "developers" | "all";

/** One skill: a template-relative file or an https address. */
export interface TemplateSkill {
  name: string;
  source: string;
  applies_to: SkillScope;
}

/** How long a budget counts for. */
export type BudgetWindow = "epoch" | "day" | "week" | "month";

/** The default budget every helper falls under. */
export interface TemplateBudget {
  window?: BudgetWindow;
  runs?: number;
  tasks_create?: number;
  messages?: number;
  llm_calls?: number;
}

/** The organization a template starts with. */
export interface TemplateOrg {
  root: { name: string; blurb?: string };
  seats: { persona: string; title?: string }[];
  default_budget?: TemplateBudget;
}

/** A parsed `template.yaml`. */
export interface Template {
  id: string;
  name: string;
  description: string;
  channels: TemplateChannel[];
  personas: TemplatePersona[];
  workflows: TemplateWorkflow[];
  docs: TemplateDoc[];
  skills: TemplateSkill[];
  welcome: string;
  org?: TemplateOrg;
}

/** A skill whose text is bundled: its identity comes from the SKILL.md front matter. */
export interface ResolvedSkill {
  name: string;
  description: string;
  /** sha256 (hex) of `content`, the pin. */
  sha256: string;
  content: string;
}

/** A template with every file it names, ready to apply. */
export interface TemplateEntry {
  template: Template;
  /** Template-relative path to file text, for every file the template names. */
  files: Record<string, string>;
  /** Bundled skills by template skill name. Skills with an https source are not here. */
  skills: Record<string, ResolvedSkill>;
}

/** What the template picker shows, without loading any file. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  channels: {
    name: string;
    purpose: string;
    /** A board of posts and replies rather than a live chat. */
    board: boolean;
    /** Only people who are added can read it. */
    private: boolean;
  }[];
  /** Helper names. */
  helpers: string[];
  /** Titles of the shared pages. */
  pages: string[];
  /** Short names of the workflows. */
  automations: string[];
  /** Skills that need the command line (their source is a web address). */
  needsCommandLine: string[];
  /** The default limit every helper starts under, or null when the template sets none. */
  defaultBudget: TemplateBudget | null;
}

/** The founder seat's helper seats are named `seat-<helper id>`. */
export function seatNodeId(personaId: string): string {
  return `seat-${personaId}`;
}

/** The page slug a document file becomes: its file name without `.md`. */
export function docSlug(file: string): string | null {
  const last = file.split("/").pop() ?? "";
  const stem = last.endsWith(".md") ? last.slice(0, -3) : last;
  return stem === "" ? null : stem;
}

/** Whether a skill's source is something this app can bundle (a file, not a web address). */
export function isRemoteSkill(skill: TemplateSkill): boolean {
  return skill.source.startsWith("https://");
}

function isKebab(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRelativePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === "")
  );
}

/**
 * Every way a template breaks the contract, in words. Empty means valid. The
 * same bounds the command line enforces at apply time, checked here at build
 * time so a template that would be refused never ships.
 */
export function validateTemplate(entry: TemplateEntry): string[] {
  const problems: string[] = [];
  const { template: t, files } = entry;
  const fail = (message: string) => problems.push(`${t.id}: ${message}`);

  const needFile = (what: string, path: string | undefined) => {
    if (path === undefined) return;
    if (!isRelativePath(path)) {
      fail(
        `${what} path ${JSON.stringify(path)} must be relative and stay inside the template`,
      );
    } else if (files[path] === undefined) {
      fail(`${what} file ${path} is missing`);
    }
  };

  if (!isKebab(t.id)) fail("id must be kebab-case");
  if (t.name.trim() === "" || t.name.length > MAX_NAME) {
    fail(`name must be 1..${MAX_NAME} characters`);
  }
  if (t.description.trim() === "" || t.description.length > MAX_DESCRIPTION) {
    fail(`description must be 1..${MAX_DESCRIPTION} characters`);
  }

  if (t.channels.length < 1 || t.channels.length > MAX_CHANNELS) {
    fail(`channels must be 1..${MAX_CHANNELS}`);
  }
  const channelIds = new Set<string>();
  for (const channel of t.channels) {
    if (!isKebab(channel.id))
      fail(`channel id ${channel.id} must be kebab-case`);
    if (channelIds.has(channel.id))
      fail(`channel id ${channel.id} is repeated`);
    channelIds.add(channel.id);
    if (channel.name.trim() === "") fail(`channel ${channel.id} needs a name`);
    if (channel.purpose.length > MAX_PURPOSE) {
      fail(`channel ${channel.id} purpose is over ${MAX_PURPOSE} characters`);
    }
    if (
      channel.type !== undefined &&
      channel.type !== "chat" &&
      channel.type !== "board"
    ) {
      fail(`channel ${channel.id} type must be chat or board`);
    }
    if (
      channel.visibility !== undefined &&
      channel.visibility !== "open" &&
      channel.visibility !== "private"
    ) {
      fail(`channel ${channel.id} visibility must be open or private`);
    }
    needFile(`channel ${channel.id} seed`, channel.seed);
  }
  // The welcome message is a chat message posted to the first channel.
  if (t.channels[0] && isBoardChannel(t.channels[0])) {
    fail(
      "the first channel receives the welcome message, so it must be a chat, not a board",
    );
  }

  if (t.personas.length > MAX_PERSONAS)
    fail(`personas must be at most ${MAX_PERSONAS}`);
  const personaIds = new Set<string>();
  const skillNames = new Set(t.skills.map((skill) => skill.name));
  for (const persona of t.personas) {
    if (!isKebab(persona.id))
      fail(`persona id ${persona.id} must be kebab-case`);
    if (personaIds.has(persona.id))
      fail(`persona id ${persona.id} is repeated`);
    personaIds.add(persona.id);
    if (persona.name.trim() === "" || persona.name.length > MAX_NAME) {
      fail(`persona ${persona.id} name must be 1..${MAX_NAME} characters`);
    }
    needFile(`persona ${persona.id} prompt`, persona.prompt);
    for (const skill of persona.skills ?? []) {
      if (!skillNames.has(skill)) {
        fail(`persona ${persona.id} names unknown skill ${skill}`);
      }
    }
  }

  if (t.workflows.length > MAX_WORKFLOWS)
    fail(`workflows must be at most ${MAX_WORKFLOWS}`);
  for (const workflow of t.workflows) {
    needFile("workflow", workflow.file);
    if (workflow.channel !== undefined && !channelIds.has(workflow.channel)) {
      fail(
        `workflow ${workflow.file} names unknown channel ${workflow.channel}`,
      );
    }
    const bound = t.channels.find((c) => c.id === workflow.channel);
    if (bound && isBoardChannel(bound)) {
      fail(
        `workflow ${workflow.file} runs on chat messages, but channel ${bound.id} is a board`,
      );
    }
  }

  if (t.docs.length > MAX_DOCS) fail(`docs must be at most ${MAX_DOCS}`);
  const slugs = new Set<string>();
  for (const doc of t.docs) {
    needFile("doc", doc.file);
    const slug = docSlug(doc.file);
    if (slug === null) fail(`doc ${doc.file} has no file name`);
    else if (slugs.has(slug)) fail(`two docs would become the page ${slug}`);
    else slugs.add(slug);
    if (doc.title.trim() === "") fail(`doc ${doc.file} needs a title`);
  }

  if (t.skills.length > MAX_SKILLS)
    fail(`skills must be at most ${MAX_SKILLS}`);
  for (const skill of t.skills) {
    if (skill.name.trim() === "" || skill.name.length > MAX_NAME) {
      fail(`skill name must be 1..${MAX_NAME} characters`);
    }
    if (skill.applies_to !== "developers" && skill.applies_to !== "all") {
      fail(`skill ${skill.name} applies_to must be developers or all`);
    }
    if (isRemoteSkill(skill)) continue;
    needFile(`skill ${skill.name} source`, skill.source);
    if (
      files[skill.source] !== undefined &&
      entry.skills[skill.name] === undefined
    ) {
      fail(`skill ${skill.name} is not resolved`);
    }
  }

  needFile("welcome", t.welcome);

  if (t.org) {
    const org = t.org;
    if (org.root.name.trim() === "" || org.root.name.length > MAX_NAME) {
      fail(`org root name must be 1..${MAX_NAME} characters`);
    }
    if ((org.root.blurb ?? "").length > MAX_ORG_BLURB) {
      fail(`org root blurb is over ${MAX_ORG_BLURB} characters`);
    }
    if (org.seats.length > MAX_PERSONAS)
      fail("org has more seats than a template may have helpers");
    const seated = new Set<string>();
    for (const seat of org.seats) {
      if (!personaIds.has(seat.persona))
        fail(`org seat names unknown persona ${seat.persona}`);
      if (seated.has(seat.persona))
        fail(`persona ${seat.persona} has two seats`);
      seated.add(seat.persona);
    }
    const budget = org.default_budget;
    if (budget) {
      if (
        budget.window !== undefined &&
        !["epoch", "day", "week", "month"].includes(budget.window)
      ) {
        fail("default_budget window must be epoch, day, week or month");
      }
      for (const [key, value] of Object.entries(budget)) {
        if (key === "window") continue;
        if (
          !Number.isInteger(value) ||
          (value as number) < 1 ||
          (value as number) > MAX_DEFAULT_BUDGET_LIMIT
        ) {
          fail(
            `default_budget ${key} must be a whole number from 1 to ${MAX_DEFAULT_BUDGET_LIMIT}`,
          );
        }
      }
    }
  }

  for (const [path, text] of Object.entries(files)) {
    if (byteLength(text) > MAX_FILE_BYTES)
      fail(`${path} is over ${MAX_FILE_BYTES} bytes`);
  }
  return problems;
}
