export const KIND_DELETION = 5;
export const KIND_REACTION = 7;
export const KIND_TEXT_NOTE = 1;
export const KIND_STREAM_MESSAGE = 9;
// Buzz-native deletion. The relay soft-deletes the target and emits a
// kind:40099 system message. Treated as a deletion marker alongside kind:5.
export const KIND_NIP29_DELETE_EVENT = 9005;
// NIP-56 report + community-moderation command kinds. Reports (1984) persist to
// the mod queue only; commands (9040–9044) are relay-validated and never stored.
// Tag shapes are pinned by buzz-sdk builders + relay moderation_commands.rs.
export const KIND_REPORT = 1984;
export const KIND_PRODUCT_FEEDBACK = 42000;
export const KIND_IA_ARCHIVE_REQUEST = 9035;
export const KIND_MODERATION_BAN = 9040;
export const KIND_MODERATION_UNBAN = 9041;
export const KIND_MODERATION_TIMEOUT = 9042;
export const KIND_MODERATION_UNTIMEOUT = 9043;
export const KIND_MODERATION_RESOLVE_REPORT = 9044;
export const KIND_STREAM_MESSAGE_V2 = 40002;
export const KIND_STREAM_MESSAGE_EDIT = 40003;
export const KIND_CHANNEL_THREAD_SUMMARY = 39005;
export const KIND_CHANNEL_WINDOW_BOUNDS = 39006;
export const KIND_STREAM_MESSAGE_DIFF = 40008;
export const KIND_REMINDER = 40007;
export const KIND_SYSTEM_MESSAGE = 40099;
export const KIND_JOB_REQUEST = 43001;
export const KIND_JOB_ACCEPTED = 43002;
export const KIND_JOB_PROGRESS = 43003;
export const KIND_JOB_RESULT = 43004;
export const KIND_JOB_CANCEL = 43005;
export const KIND_JOB_ERROR = 43006;
export const KIND_FORUM_POST = 45001;
export const KIND_FORUM_COMMENT = 45003;
export const KIND_APPROVAL_REQUEST = 46010;
export const KIND_MEMBER_ADDED_NOTIFICATION = 44100;
export const KIND_MEMBER_REMOVED_NOTIFICATION = 44101;
export const KIND_TYPING_INDICATOR = 20002;
export const KIND_PRESENCE_UPDATE = 20001;
export const KIND_HUDDLE_REACTION = 24810;
export const KIND_HUDDLE_STARTED = 48100;
export const KIND_HUDDLE_PARTICIPANT_JOINED = 48101;
export const KIND_HUDDLE_PARTICIPANT_LEFT = 48102;
export const KIND_HUDDLE_ENDED = 48103;
export const KIND_HUDDLE_LIVENESS = 48104;
// NIP-78 application-specific data. All use kind 30078; the relay
// differentiates them by d-tag ("read-state:<slotId>", "channel-sections",
// "channel-mutes", "channel-stars", "channel-sort", "project-sidebar-membership").
export const KIND_READ_STATE = 30078;
export const KIND_CHANNEL_SECTIONS = 30078;
export const KIND_CHANNEL_MUTES = 30078;
export const KIND_CHANNEL_STARS = 30078;
export const KIND_CHANNEL_SORT = 30078;
export const KIND_PROJECT_SIDEBAR_MEMBERSHIP = 30078;
export const KIND_COMMUNITY_THEME = 30078;
// NIP-33 persona/team/managed-agent projection events (d-tag keyed). Published
// backend-side as secrets-stripped snapshots; the inbound sync hook subscribes
// to all three to patch local records. Mirror of buzz-core's KIND_PERSONA etc.
export const KIND_PERSONA = 30175;
export const KIND_TEAM = 30176;
export const KIND_MANAGED_AGENT = 30177;
// Team catalog projection: a self-contained snapshot of a team plus every
// member's safe definition, so a recipient can rebuild it without reading the
// publisher's personas. Separate from KIND_TEAM (30176, the team's own wire
// body) so an ordinary team edit cannot disturb catalog share state.
export const KIND_TEAM_CATALOG = 30178;
export const KIND_USER_STATUS = 30315;
export const KIND_AGENT_OBSERVER_FRAME = 24200;
export const KIND_AGENT_TURN_METRIC = 44200;
// Agent fleet cooperation plane (mirror of buzz-core 44010–44019).
export const KIND_AGENT_CAPABILITIES = 44010;
export const KIND_AGENT_TASK = 44011;
// Human wiki page (d = slug, content = markdown). Live-collab editing
// (Yjs/Trystero) is web-only; the desktop surface reads these read-only.
export const KIND_WIKI_PAGE = 44001;
// Agent Wiki (mirror of buzz-core 44002): agent-maintained knowledge base
// pages (d = "<space>/<slug>", content = markdown). Distinct from the human
// wiki page kind 44001 (Yjs/Trystero live editing).
export const KIND_AGENT_WIKI_PAGE = 44002;
// Self-organizing agent teams (sat) — mirror of buzz-core 44020-44022
// (arXiv 2609.22682 teamwork strategies; see docs/agent-teams.md).
// Strategy definitions (d = strategy id), executed runs (d = run id), and
// per-turn records (d = "<run-id>/<phase>/<agentSlot>").
export const KIND_TEAM_STRATEGY = 44020;
export const KIND_TEAM_RUN = 44021;
export const KIND_TEAM_TURN = 44022;
export const KIND_WORKFLOW_TRIGGERED = 46001;
export const KIND_WORKFLOW_COMPLETED = 46005;
export const KIND_WORKFLOW_FAILED = 46006;
export const KIND_EVENT_REMINDER = 30300;
export const KIND_REPO_ANNOUNCEMENT = 30617;
export const KIND_REPO_STATE = 30618;
// NIP-MP: project grouping above NIP-34 repositories.
export const KIND_PROJECT_ANNOUNCEMENT = 30621;
// NIP-LP: DAO launchpad (docs/nips/NIP-LP.md). 47006-47009 reserved.
export const KIND_LAUNCH_RECORD = 37001;
export const KIND_LAUNCH_BID = 47002;
export const KIND_LAUNCH_UPDATE = 47003;
export const KIND_LAUNCH_PROPOSAL = 47004;
export const KIND_LAUNCH_RECEIPT = 47005;
export const KIND_SCORE_ROOT = 37006;
// NIP-ORG: community org graph (addressable, d = id). Community-level and
// global-only: no `h` routing tag (`h` is the NIP-29 channel tag, and a stray one
// never channel-scopes these kinds).
export const KIND_ORG_NODE = 37010;
export const KIND_ORG_GRANT = 37011;
export const KIND_ORG_BUDGET = 37012;
export const KIND_CONTRIBUTION_RECORD = 37013;
export const KIND_BUDGET_SPEND_RECEIPT = 37014;
// NIP-ORG (Project Board): project pitch / team manifest (d = the project's
// org-node id; declared roles as ["role", slug, label, pct] tags) and a member's
// request to fill one declared role (d = "<node>/<role>/<requester-16>"; a
// decline republishes the same d under the founder's key). Mirror of buzz-core.
export const KIND_ORG_PITCH = 37015;
export const KIND_ORG_JOIN_REQUEST = 37016;
// NIP-ORG (Discovery plane): EVM binding — "which address holds this seat",
// authored by the bound npub (d = the bound 0x… address) — and deployment
// record — "where is the Summoner" (d = "<chainId>:<role>"). Mirror of buzz-core.
export const KIND_EVM_BINDING = 37017;
export const KIND_DEPLOYMENT_RECORD = 37018;
// Relay hash-chain audit entry (mirror of buzz-core KIND_AUDIT_ENTRY): signed by
// the relay, readable by community owners and admins only. See
// features/org/lib/auditChain.ts for what verifying the chain does and does not
// prove.
export const KIND_AUDIT_ENTRY = 48001;
// Agent skill definition (mirror of buzz-core KIND_SKILL): a shareable Agent
// Skills instruction set (d = skill id; community-level and global-only).
export const KIND_SKILL = 30180;
export const ORG_EVENT_KINDS = [
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_ORG_PITCH,
  KIND_ORG_JOIN_REQUEST,
] as const;
export const LAUNCHPAD_EVENT_KINDS = [
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_BID,
  KIND_LAUNCH_UPDATE,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_SCORE_ROOT,
] as const;
export const KIND_GIT_PATCH = 1617;
export const KIND_GIT_PULL_REQUEST = 1618;
export const KIND_GIT_PR_UPDATE = 1619;
export const KIND_GIT_ISSUE = 1621;
export const KIND_GIT_STATUS_OPEN = 1630;
export const KIND_GIT_STATUS_MERGED = 1631;
export const KIND_GIT_STATUS_CLOSED = 1632;
export const KIND_GIT_STATUS_DRAFT = 1633;
// NIP-DV: relay-signed per-viewer DM visibility snapshot (d=viewer pubkey,
// h-tags = currently-hidden DM channel ids).
export const KIND_DM_VISIBILITY = 30622;

// Human-visible "new content" message kinds. Used as the unread trigger set
// (sidebar badges, catch-up queries) and as the Home-feed mention query.
// Reactions, edits, diffs, deletions, and system messages are deliberately
// excluded: they can land after the last human-visible message and would
// otherwise create phantom unreads.
export const CHANNEL_MESSAGE_EVENT_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
] as const;

// Keep this in sync with the Home-feed mention query in buzz-db.
export const HOME_MENTION_EVENT_KINDS = [...CHANNEL_MESSAGE_EVENT_KINDS];

export const CHANNEL_EVENT_KINDS = [
  KIND_DELETION, // 5 — NIP-09 event deletions
  KIND_REACTION, // 7 — NIP-25 reactions
  KIND_NIP29_DELETE_EVENT, // 9005 — NIP-29 / Buzz-native deletions
  ...CHANNEL_MESSAGE_EVENT_KINDS,
  40001, // legacy: pre-migration stream messages
  KIND_STREAM_MESSAGE_EDIT, // 40003 — message edits
  KIND_STREAM_MESSAGE_DIFF, // 40008 — message diffs
  KIND_SYSTEM_MESSAGE, // 40099 — system messages (join, leave, etc.)
  KIND_HUDDLE_STARTED, // 48100 — visible huddle session card
  KIND_HUDDLE_PARTICIPANT_JOINED, // 48101 — huddle lifecycle overlay
  KIND_HUDDLE_PARTICIPANT_LEFT, // 48102 — huddle lifecycle overlay
  KIND_HUDDLE_ENDED, // 48103 — huddle lifecycle overlay
] as const;

// Auxiliary (non-row) timeline kinds: events that overlay onto or hide an
// existing message rather than rendering their own row — reactions, edits, and
// deletions. History fetches request the visible content kinds only, so the
// `limit` budget buys visible message depth instead of being diluted by these
// (on a reaction-heavy channel a 200-event window was only ~136 messages).
// They are backfilled separately by `#e` reference over the loaded message ids
// — by reference, not by time window, so a late edit/delete for a visible old
// message still applies. NOTE: kind:40008 (diff) renders its OWN row, so it is
// a content kind, not aux.
export const CHANNEL_AUX_EVENT_KINDS = [
  KIND_DELETION, // 5 — NIP-09 event deletions
  KIND_REACTION, // 7 — NIP-25 reactions
  KIND_NIP29_DELETE_EVENT, // 9005 — NIP-29 / Buzz-native deletions
  KIND_STREAM_MESSAGE_EDIT, // 40003 — message edits
] as const;

// Visible content kinds the main timeline renders as their own rows. Mirrors
// `isTimelineContentEvent` in formatTimelineMessages.ts — keep the two in sync.
// This is the kind set the history fetch requests so the `limit` budget maps
// to visible rows; auxiliary overlays (CHANNEL_AUX_EVENT_KINDS) are fetched
// separately by `#e` reference. Forum kinds (45001/45003) are excluded: forum
// channels use a different query path, not this timeline.
export const CHANNEL_TIMELINE_CONTENT_KINDS = [
  KIND_STREAM_MESSAGE, // 9
  KIND_STREAM_MESSAGE_V2, // 40002
  KIND_STREAM_MESSAGE_DIFF, // 40008 — diff messages (own row)
  KIND_SYSTEM_MESSAGE, // 40099 — system rows (join/leave/channel-created)
  KIND_JOB_REQUEST, // 43001
  KIND_JOB_ACCEPTED, // 43002
  KIND_JOB_PROGRESS, // 43003
  KIND_JOB_RESULT, // 43004
  KIND_JOB_CANCEL, // 43005
  KIND_JOB_ERROR, // 43006
  KIND_HUDDLE_STARTED, // 48100 — huddle session card
] as const;

// Timeline kinds that are NOT conversational: relay-signed system rows
// (channel-created, member-joined) and job-lifecycle events. These render in
// the timeline but must not count toward the channel's unread pill — a freshly
// created channel carries one channel_created + N member_joined system rows
// that would otherwise show as phantom unreads ("4 unread, 1 message").
const NON_CONVERSATIONAL_UNREAD_KINDS: ReadonlySet<number> = new Set([
  KIND_SYSTEM_MESSAGE, // 40099
  KIND_JOB_REQUEST, // 43001
  KIND_JOB_ACCEPTED, // 43002
  KIND_JOB_PROGRESS, // 43003
  KIND_JOB_RESULT, // 43004
  KIND_JOB_CANCEL, // 43005
  KIND_JOB_ERROR, // 43006
  KIND_HUDDLE_STARTED, // 48100 — huddle cards are visible but non-conversational
  KIND_HUDDLE_PARTICIPANT_JOINED, // 48101
  KIND_HUDDLE_PARTICIPANT_LEFT, // 48102
  KIND_HUDDLE_ENDED, // 48103
]);

// Whether a timeline message kind should count toward unread tallies. An
// undefined kind (optimistic/pending rows whose kind has not populated) is
// treated as conversational so a legitimately unread message is never dropped.
export function isConversationalUnreadKind(kind: number | undefined): boolean {
  return kind === undefined || !NON_CONVERSATIONAL_UNREAD_KINDS.has(kind);
}
