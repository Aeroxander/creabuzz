/**
 * Canonical Nostr event-kind table shared by the Creaton web and desktop
 * apps. Mirrors `crates/buzz-core/src/kind.rs` — the Rust registry is the
 * protocol source of truth; this is the client-side copy of the integers,
 * kept in ONE place so the two apps cannot drift.
 *
 * Both apps re-export this module from their `shared/constants/kinds.ts`
 * shim. Values and names are wire format: never rename or renumber here
 * without changing the relay and the NIPs with it.
 */

// ── NIP-01/02/09/25/51 basics ─────────────────────────────────────────────
/** Standard Nostr short note (NIP-01): feed posts and launch discussion. */
export const KIND_TEXT_NOTE = 1;
/** Standard follow list (NIP-02): the people someone follows. */
export const KIND_CONTACT_LIST = 3;
/** NIP-09 event deletion. */
export const KIND_DELETION = 5;
/** Standard reaction (NIP-25): `+` / `-` votes in the feed. */
export const KIND_REACTION = 7;
/** Legacy stream message (pre-migration chat rows). */
export const KIND_STREAM_MESSAGE = 9;
/** Standard bookmark list (NIP-51): the launches someone follows (`a` tags). */
export const KIND_BOOKMARK_LIST = 10003;

// ── Git (NIP-34) ──────────────────────────────────────────────────────────
export const KIND_GIT_PATCH = 1617;
export const KIND_GIT_PULL_REQUEST = 1618;
export const KIND_GIT_PR_UPDATE = 1619;
/** NIP-34: Git issue (repo-scoped work item). */
export const KIND_GIT_ISSUE = 1621;
export const KIND_GIT_STATUS_OPEN = 1630;
export const KIND_GIT_STATUS_MERGED = 1631;
export const KIND_GIT_STATUS_CLOSED = 1632;
export const KIND_GIT_STATUS_DRAFT = 1633;

// ── Moderation & reporting ────────────────────────────────────────────────
/** NIP-56 report. Persists to the mod queue only. */
export const KIND_REPORT = 1984;
export const KIND_PRODUCT_FEEDBACK = 42000;
export const KIND_IA_ARCHIVE_REQUEST = 9035;
/**
 * Community-moderation commands (9040–9044): relay-validated, never stored.
 * Tag shapes are pinned by buzz-sdk builders + relay moderation_commands.rs.
 */
export const KIND_MODERATION_BAN = 9040;
export const KIND_MODERATION_UNBAN = 9041;
export const KIND_MODERATION_TIMEOUT = 9042;
export const KIND_MODERATION_UNTIMEOUT = 9043;
export const KIND_MODERATION_RESOLVE_REPORT = 9044;
/**
 * Buzz-native deletion. The relay soft-deletes the target and emits a
 * kind:40099 system message. Treated as a deletion marker alongside kind:5.
 */
export const KIND_NIP29_DELETE_EVENT = 9005;

// ── Presence / typing ─────────────────────────────────────────────────────
export const KIND_PRESENCE_UPDATE = 20001;
export const KIND_TYPING_INDICATOR = 20002;

// ── Agent observation & metrics ───────────────────────────────────────────
export const KIND_AGENT_OBSERVER_FRAME = 24200;
export const KIND_HUDDLE_REACTION = 24810;
export const KIND_AGENT_TURN_METRIC = 44200;

// ── NIP-78 application data (all kind 30078, d-tag differentiated) ───────
// The relay differentiates them by d-tag ("read-state:<slotId>",
// "channel-sections", "channel-mutes", "channel-stars", "channel-sort",
// "project-sidebar-membership", "community-theme").
export const KIND_READ_STATE = 30078;
export const KIND_CHANNEL_SECTIONS = 30078;
export const KIND_CHANNEL_MUTES = 30078;
export const KIND_CHANNEL_STARS = 30078;
export const KIND_CHANNEL_SORT = 30078;
export const KIND_PROJECT_SIDEBAR_MEMBERSHIP = 30078;
export const KIND_COMMUNITY_THEME = 30078;

// ── NIP-33 persona/team/managed-agent projections (d-tag keyed) ───────────
// Published backend-side as secrets-stripped snapshots; the inbound sync hook
// subscribes to all of them to patch local records.
export const KIND_PERSONA = 30175;
export const KIND_TEAM = 30176;
export const KIND_MANAGED_AGENT = 30177;
/**
 * Team catalog projection: a self-contained snapshot of a team plus every
 * member's safe definition, so a recipient can rebuild it without reading the
 * publisher's personas. Distinct from KIND_TEAM (30176, the team's own wire
 * body) so an ordinary team edit cannot disturb catalog share state.
 */
export const KIND_TEAM_CATALOG = 30178;

/** Agent skill definition (addressable, d = skill id; community-level and global-only). */
export const KIND_SKILL = 30180;
export const KIND_EVENT_REMINDER = 30300;
export const KIND_USER_STATUS = 30315;

// ── Repos & projects ──────────────────────────────────────────────────────
export const KIND_REPO_ANNOUNCEMENT = 30617;
export const KIND_REPO_STATE = 30618;
/** NIP-MP: project grouping above NIP-34 repositories. */
export const KIND_PROJECT_ANNOUNCEMENT = 30621;
/**
 * NIP-DV: relay-signed per-viewer DM visibility snapshot (d = viewer pubkey,
 * h-tags = currently-hidden DM channel ids).
 */
export const KIND_DM_VISIBILITY = 30622;

// ── Chat, channels, huddles ───────────────────────────────────────────────
export const KIND_CHANNEL_THREAD_SUMMARY = 39005;
export const KIND_CHANNEL_WINDOW_BOUNDS = 39006;
export const KIND_STREAM_MESSAGE_V2 = 40002;
export const KIND_STREAM_MESSAGE_EDIT = 40003;
export const KIND_REMINDER = 40007;
export const KIND_STREAM_MESSAGE_DIFF = 40008;
export const KIND_SYSTEM_MESSAGE = 40099;
export const KIND_HUDDLE_STARTED = 48100;
export const KIND_HUDDLE_PARTICIPANT_JOINED = 48101;
export const KIND_HUDDLE_PARTICIPANT_LEFT = 48102;
export const KIND_HUDDLE_ENDED = 48103;
export const KIND_HUDDLE_LIVENESS = 48104;

// ── Jobs & workflows ──────────────────────────────────────────────────────
export const KIND_JOB_REQUEST = 43001;
export const KIND_JOB_ACCEPTED = 43002;
export const KIND_JOB_PROGRESS = 43003;
export const KIND_JOB_RESULT = 43004;
export const KIND_JOB_CANCEL = 43005;
export const KIND_JOB_ERROR = 43006;
export const KIND_WORKFLOW_TRIGGERED = 46001;
export const KIND_WORKFLOW_COMPLETED = 46005;
export const KIND_WORKFLOW_FAILED = 46006;

export const KIND_FORUM_POST = 45001;
export const KIND_FORUM_COMMENT = 45003;
export const KIND_APPROVAL_REQUEST = 46010;
export const KIND_MEMBER_ADDED_NOTIFICATION = 44100;
export const KIND_MEMBER_REMOVED_NOTIFICATION = 44101;

// ── Wiki & agent teams (mirror of buzz-core 44001–44022) ──────────────────
/** Human wiki page (addressable, d = slug, content = markdown). */
export const KIND_WIKI_PAGE = 44001;
/** Agent Wiki page (addressable, d = "<space>/<slug>", content = markdown). */
export const KIND_AGENT_WIKI_PAGE = 44002;
/** Agent fleet: capabilities advertisement (addressable, d = agent id). */
export const KIND_AGENT_CAPABILITIES = 44010;
/** Agent fleet: coordination task (addressable, d = task id, #p assignee). */
export const KIND_AGENT_TASK = 44011;
/**
 * Self-organizing agent teams (SAT) — mirror of buzz-core 44020-44022
 * (arXiv 2609.22682 teamwork strategies; see docs/agent-teams.md).
 * Strategy definitions (d = strategy id), executed runs (d = run id), and
 * per-turn records (d = "<run-id>/<phase>/<agentSlot>").
 */
export const KIND_TEAM_STRATEGY = 44020;
export const KIND_TEAM_RUN = 44021;
export const KIND_TEAM_TURN = 44022;

// ── NIP-LP: DAO launchpad (docs/nips/NIP-LP.md) ───────────────────────────
/** DAO launch record (addressable, d = launch id). */
export const KIND_LAUNCH_RECORD = 37001;
/** (reserved) trustgraph score root published by an operator. */
export const KIND_SCORE_ROOT = 37006;
/** Auction bid mirror. */
export const KIND_LAUNCH_BID = 47002;
/** Founder-signed launch update. */
export const KIND_LAUNCH_UPDATE = 47003;
/** Proposal record (plain, futarchy-budget, signal). */
export const KIND_LAUNCH_PROPOSAL = 47004;
/** Chain-state receipt mirror. */
export const KIND_LAUNCH_RECEIPT = 47005;
/** Royalty schedule mirror (chain authoritative; token-lifecycle-design.md). */
export const KIND_ROYALTY_SCHEDULE = 47006;
/** Royalty settlement-close mirror (one per closed window). 47008-47009 reserved. */
export const KIND_ROYALTY_CLOSE = 47007;

// ── NIP-ORG: community org graph ──────────────────────────────────────────
// All addressable, d = id. Community-level and global-only: no `h` routing
// tag (`h` is the NIP-29 channel tag, and a stray one never channel-scopes
// these kinds).
/** Org node — a role/team seat in the community org chart (d = node id). */
export const KIND_ORG_NODE = 37010;
/** Org grant — a scoped, revocable delegation of authority (d = grant id). */
export const KIND_ORG_GRANT = 37011;
/** Budget — a bound on agent/delegated autonomy (d = subject id). */
export const KIND_ORG_BUDGET = 37012;
/** Contribution record — verified action with multi-dimensional profile (d = action id). */
export const KIND_CONTRIBUTION_RECORD = 37013;
/** Budget spend receipt — Nostr mirror of a spend settled onchain (d = spend id). */
export const KIND_BUDGET_SPEND_RECEIPT = 37014;
/** Project pitch / team manifest — board-facing pitch + declared roles (d = the project's org-node id). */
export const KIND_ORG_PITCH = 37015;
/**
 * Project join request — request a declared role for a stated %
 * (d = `<node>/<role>/<requester-16>`); a decline republishes the same d
 * under the founder's key.
 */
export const KIND_ORG_JOIN_REQUEST = 37016;
/**
 * NIP-ORG (Discovery plane): EVM binding — "which address holds this seat",
 * authored by the bound npub (d = the bound `0x…` address).
 */
export const KIND_EVM_BINDING = 37017;
/** NIP-ORG (Discovery plane): deployment record — "where is the Summoner" (d = `<chainId>:<role>`). */
export const KIND_DEPLOYMENT_RECORD = 37018;

// ── Relay administration ──────────────────────────────────────────────────
/**
 * Relay hash-chain audit entry — relay-signed, readable by community owners
 * and admins only.
 */
export const KIND_AUDIT_ENTRY = 48001;

// ── Grouped kind sets ─────────────────────────────────────────────────────
/** All NIP-ORG event kinds. */
export const ORG_EVENT_KINDS = [
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_ORG_PITCH,
  KIND_ORG_JOIN_REQUEST,
] as const;
/** All NIP-LP event kinds. */
export const LAUNCHPAD_EVENT_KINDS = [
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_BID,
  KIND_LAUNCH_UPDATE,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_SCORE_ROOT,
] as const;
