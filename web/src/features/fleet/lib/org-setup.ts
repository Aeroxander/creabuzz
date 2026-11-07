/**
 * Setting up an organization, in plain words.
 *
 * An organization here is a short list of signed records on the community's server: a team (with you in it), the
 * helpers (agents) who work for it, and a default limit on how much those helpers may do before they have to ask. This
 * module is the whole of what the setup flow decides: what to ask, what each answer means, and the exact records that
 * get published. The page (`../ui/OrgSetup.tsx`) only shows it.
 *
 * Nothing here is invented for the screen: each choice maps to a record the server already understands (NIP-ORG:
 * `37010` org node, `37012` budget), and every limit offered is one the server actually counts. Spending limits are not
 * offered because the server does not count them; they belong to the DAO's treasury, which has its own page.
 *
 * Alias-free on purpose: `org-setup.test.mjs` drives it under `node --test`.
 */

import {
  buildOrgBudgetContent,
  COMMUNITY_DEFAULT_SUBJECT,
} from "../../budgets/lib/budgetForm.ts";

const KIND_ORG_NODE = 37010;
const KIND_ORG_BUDGET = 37012;

export const ORG_NAME_MAX = 60;
export const ORG_PURPOSE_MAX = 140;
export const ROLE_NAME_MAX = 40;

// ---------------------------------------------------------------------------
// How much helpers may do alone
// ---------------------------------------------------------------------------

export type AutonomyId = "careful" | "balanced" | "independent";

export interface AutonomyLevel {
  id: AutonomyId;
  label: string;
  /** The choice in one sentence a person would say out loud. */
  summary: string;
  /** What the server counts per day for each helper. Above this a helper asks first. */
  perDay: { runs: number; tasks: number; messages: number };
}

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  {
    id: "careful",
    label: "Check with me often",
    summary: "A helper does a few things, then waits for your yes.",
    perDay: { runs: 10, tasks: 5, messages: 50 },
  },
  {
    id: "balanced",
    label: "Balanced",
    summary: "A helper gets a normal day's work done, then asks.",
    perDay: { runs: 50, tasks: 20, messages: 300 },
  },
  {
    id: "independent",
    label: "Let them run",
    summary:
      "A helper works freely and only asks when it goes far beyond a normal day.",
    perDay: { runs: 200, tasks: 60, messages: 1000 },
  },
];

const DEFAULT_AUTONOMY: AutonomyId = "balanced";

function autonomyLevel(id: AutonomyId): AutonomyLevel {
  const level = AUTONOMY_LEVELS.find((entry) => entry.id === id);
  if (!level) throw new Error(`Unknown autonomy level: ${id}`);
  return level;
}

/** The exact allowance, as a person would read it. */
export function describeAutonomy(id: AutonomyId): string {
  const { runs, tasks, messages } = autonomyLevel(id).perDay;
  return `Each helper can run ${runs} times, start ${tasks} tasks and send ${messages} messages a day. Past that, it asks you first.`;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export interface OrgSetupDraft {
  name: string;
  purpose: string;
  /** An existing helper to seat, or null to add helpers later. */
  helper: { pubkey: string; role: string } | null;
  /** `null` leaves helpers without a default limit. */
  autonomy: AutonomyId | null;
}

export function emptyDraft(): OrgSetupDraft {
  return { name: "", purpose: "", helper: null, autonomy: DEFAULT_AUTONOMY };
}

/** A short, address-safe id from a name: "Nebula Labs!" becomes "nebula-labs". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Why the name step cannot continue, or null when it can. */
export function nameIssue(
  draft: Pick<OrgSetupDraft, "name" | "purpose">,
): string | null {
  const name = draft.name.trim();
  if (name.length < 2) return "Give your organization a name.";
  if (name.length > ORG_NAME_MAX) {
    return `Keep the name under ${ORG_NAME_MAX} characters.`;
  }
  if (slugify(name) === "")
    return "Use at least one letter or number in the name.";
  if (draft.purpose.trim().length > ORG_PURPOSE_MAX) {
    return `Keep the one-line purpose under ${ORG_PURPOSE_MAX} characters.`;
  }
  return null;
}

/** Why the helper step cannot continue, or null when it can. */
export function helperIssue(
  draft: Pick<OrgSetupDraft, "helper">,
): string | null {
  if (draft.helper === null) return null;
  if (!/^[0-9a-f]{64}$/i.test(draft.helper.pubkey)) {
    return "Pick one of the helpers in the list.";
  }
  const role = draft.helper.role.trim();
  if (role.length < 2)
    return "Say what this helper does, for example “Researcher”.";
  if (role.length > ROLE_NAME_MAX) {
    return `Keep the role under ${ROLE_NAME_MAX} characters.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// What gets published
// ---------------------------------------------------------------------------

/** One record to sign and publish, in the order it must go out. */
export interface SetupRecord {
  /** Stable key so the screen can say which step is done and retry the rest. */
  step: "team" | "helper" | "limit";
  /** What the record is, for the progress line. */
  label: string;
  kind: number;
  content: string;
  tags: string[][];
}

function rootNodeId(draft: Pick<OrgSetupDraft, "name">): string {
  return slugify(draft.name);
}

function helperNodeId(draft: Pick<OrgSetupDraft, "name" | "helper">): string {
  return `${rootNodeId(draft)}-${slugify(draft.helper?.role ?? "helper") || "helper"}`;
}

/**
 * The records for a finished draft, in publish order. The team goes first because the helper's seat points at it.
 * Every record replaces the previous one with the same id, so publishing the whole list again after a failure is safe.
 */
export function setupRecords(draft: OrgSetupDraft, me: string): SetupRecord[] {
  const issue = nameIssue(draft) ?? helperIssue(draft);
  if (issue) throw new Error(issue);
  const holder = me.toLowerCase();
  const rootId = rootNodeId(draft);
  const purpose = draft.purpose.trim();
  const records: SetupRecord[] = [
    {
      step: "team",
      label: `The ${draft.name.trim()} team`,
      kind: KIND_ORG_NODE,
      content: JSON.stringify({
        v: 1,
        name: draft.name.trim(),
        kind: "team",
        holders: [holder],
        agentSeats: [],
        scope: {},
        ...(purpose ? { ui: { blurb: purpose } } : {}),
      }),
      tags: [
        ["d", rootId],
        ["p", holder],
      ],
    },
  ];
  if (draft.helper) {
    const agent = draft.helper.pubkey.toLowerCase();
    records.push({
      step: "helper",
      label: `${draft.helper.role.trim()} seat`,
      kind: KIND_ORG_NODE,
      content: JSON.stringify({
        v: 1,
        name: draft.helper.role.trim(),
        kind: "agent_seat",
        parent: rootId,
        holders: [],
        agentSeats: [agent],
        scope: {},
      }),
      tags: [
        ["d", helperNodeId(draft)],
        ["p", agent],
      ],
    });
  }
  if (draft.autonomy) {
    const { runs, tasks, messages } = autonomyLevel(draft.autonomy).perDay;
    records.push({
      step: "limit",
      label: "What helpers may do alone",
      kind: KIND_ORG_BUDGET,
      content: buildOrgBudgetContent({
        subject: COMMUNITY_DEFAULT_SUBJECT,
        window: "day",
        limits: { runs, taskCreate: tasks, messages },
      }),
      tags: [["d", COMMUNITY_DEFAULT_SUBJECT]],
    });
  }
  return records;
}

/** The review screen's lines: everything that is about to be created, in words. */
export function reviewLines(
  draft: OrgSetupDraft,
  helperName: string | null,
): string[] {
  const lines = [`A team called “${draft.name.trim()}”, with you in it.`];
  if (draft.purpose.trim()) lines.push(`Purpose: ${draft.purpose.trim()}`);
  if (draft.helper) {
    lines.push(
      `${helperName ?? "A helper"} joins as “${draft.helper.role.trim()}”.`,
    );
  } else {
    lines.push("No helpers yet. You can add them any time.");
  }
  lines.push(
    draft.autonomy
      ? describeAutonomy(draft.autonomy)
      : "Helpers have no default limit. Anyone you add later can do as much as they like.",
  );
  return lines;
}

/**
 * What to tell a person when the server turns a record down. The server speaks in short codes; a person needs to know
 * what to do next.
 */
export function rejectionMessage(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (text.startsWith("restricted")) {
    return "Only this community's owner or an admin can start its organization. Ask one of them, or switch to a community you run.";
  }
  if (text.startsWith("invalid")) {
    return "The server did not accept those details. Check the name and the helper, then try again.";
  }
  if (/rate|too many/i.test(text)) {
    return "The server asked us to slow down. Wait a moment, then try again.";
  }
  return text
    ? `The server said no: ${text}. Try again, or ask the community's owner.`
    : "The server did not answer. Check the connection, then try again.";
}
