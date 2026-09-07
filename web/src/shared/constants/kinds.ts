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
