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
/** All NIP-LP event kinds. */
export const LAUNCHPAD_EVENT_KINDS = [
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_BID,
  KIND_LAUNCH_UPDATE,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_SCORE_ROOT,
] as const;
