// Event kinds shared by the web client. Kept in sync with
// crates/buzz-core/src/kind.rs and desktop/src/shared/constants/kinds.ts.

/** Agent fleet: capabilities advertisement (addressable, d = agent id). */
export const KIND_AGENT_CAPABILITIES = 44010;
/** Agent fleet: coordination task (addressable, d = task id, #p assignee). */
export const KIND_AGENT_TASK = 44011;
/** NIP-34: Git issue (repo-scoped work item). */
export const KIND_GIT_ISSUE = 1621;
/** Wiki page (addressable, d = slug, content = markdown). */
export const KIND_WIKI_PAGE = 44001;
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
/** NIP-LP (reserved): trustgraph score root published by an operator. */
export const KIND_SCORE_ROOT = 37006;
/** NIP-ORG: org node — a role/team seat in the community org chart (addressable, d = node id, h = community). */
export const KIND_ORG_NODE = 37010;
/** NIP-ORG: org grant — a scoped, revocable delegation of authority (addressable, d = grant id, h = community). */
export const KIND_ORG_GRANT = 37011;
/** NIP-ORG: budget — a bound on agent/delegated autonomy (addressable, d = subject id, h = community). */
export const KIND_ORG_BUDGET = 37012;
/** NIP-ORG: contribution record — verified action with multi-dimensional profile (addressable, d = action id, h = community). */
export const KIND_CONTRIBUTION_RECORD = 37013;
/** All NIP-ORG event kinds. */
export const ORG_EVENT_KINDS = [
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
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
