// Event kinds shared by the web client. Kept in sync with
// crates/buzz-core/src/kind.rs and desktop/src/shared/constants/kinds.ts.

/** Standard Nostr short note (NIP-01): feed posts and launch discussion. */
export const KIND_TEXT_NOTE = 1;
/** Standard follow list (NIP-02): the people someone follows. */
export const KIND_CONTACT_LIST = 3;
/** Standard reaction (NIP-25): `+` / `-` votes in the feed. */
export const KIND_REACTION = 7;
/** Standard bookmark list (NIP-51): the launches someone follows (`a` tags). */
export const KIND_BOOKMARK_LIST = 10003;

/** Agent fleet: capabilities advertisement (addressable, d = agent id). */
export const KIND_AGENT_CAPABILITIES = 44010;
/** Agent fleet: coordination task (addressable, d = task id, #p assignee). */
export const KIND_AGENT_TASK = 44011;
/** NIP-34: Git issue (repo-scoped work item). */
export const KIND_GIT_ISSUE = 1621;
/** Wiki page (addressable, d = slug, content = markdown). */
export const KIND_WIKI_PAGE = 44001;
/** Agent Wiki page (addressable, d = "<space>/<slug>", content = markdown). */
export const KIND_AGENT_WIKI_PAGE = 44002;
/**
 * Self-organizing agent teams (SAT) — mirror of buzz-core 44020-44022
 * (arXiv 2609.22682 teamwork strategies; see docs/agent-teams.md).
 */
export const KIND_TEAM_STRATEGY = 44020;
export const KIND_TEAM_RUN = 44021;
export const KIND_TEAM_TURN = 44022;
/** NIP-LP: DAO launch record (addressable, d = launch id). */
export const KIND_LAUNCH_RECORD = 37001;
/** NIP-LP: auction bid mirror. */
export const KIND_LAUNCH_BID = 47002;
/** NIP-LP: founder-signed launch update. */
export const KIND_LAUNCH_UPDATE = 47003;
/** NIP-LP: proposal record (plain, futarchy-budget, signal). */
export const KIND_LAUNCH_PROPOSAL = 47004;
/** NIP-LP: chain-state receipt mirror. */
export const KIND_LAUNCH_RECEIPT = 47005;
/** NIP-LP: royalty schedule mirror (chain authoritative; token-lifecycle-design.md). */
export const KIND_ROYALTY_SCHEDULE = 47006;
/** NIP-LP: royalty settlement-close mirror (one per closed window). */
export const KIND_ROYALTY_CLOSE = 47007;
/** NIP-LP (reserved): trustgraph score root published by an operator. */
export const KIND_SCORE_ROOT = 37006;
/** NIP-ORG: org node — a role/team seat in the community org chart (addressable, d = node id; community-level, no `h` tag). */
export const KIND_ORG_NODE = 37010;
/** NIP-ORG: org grant — a scoped, revocable delegation of authority (addressable, d = grant id; community-level, no `h` tag). */
export const KIND_ORG_GRANT = 37011;
/** NIP-ORG: budget — a bound on agent/delegated autonomy (addressable, d = subject id; community-level, no `h` tag). */
export const KIND_ORG_BUDGET = 37012;
/** NIP-ORG: contribution record — verified action with multi-dimensional profile (addressable, d = action id; community-level, no `h` tag). */
export const KIND_CONTRIBUTION_RECORD = 37013;
/** NIP-ORG: budget spend receipt — Nostr mirror of a spend settled against an onchain allowance (addressable, d = spend id). */
export const KIND_BUDGET_SPEND_RECEIPT = 37014;
/** NIP-ORG: project pitch / team manifest — board-facing pitch + declared roles (addressable, d = the project's org-node id). */
export const KIND_ORG_PITCH = 37015;
/** NIP-ORG: project join request — request a declared role for a stated % (addressable, d = `<node>/<role>/<requester-16>`); a decline republishes the same d under the founder's key. */
export const KIND_ORG_JOIN_REQUEST = 37016;
/** NIP-ORG (Discovery plane): EVM binding — "which address holds this seat", authored by the bound npub (addressable, d = the bound `0x…` address). */
export const KIND_EVM_BINDING = 37017;
/** NIP-ORG (Discovery plane): deployment record — "where is the Summoner" (addressable, d = `<chainId>:<role>`). */
export const KIND_DEPLOYMENT_RECORD = 37018;
/** Agent skill definition — a shareable Agent Skills instruction set (addressable, d = skill id; community-level and global-only). */
export const KIND_SKILL = 30180;
/** Relay hash-chain audit entry — relay-signed, readable by community owners and admins only. */
export const KIND_AUDIT_ENTRY = 48001;
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
