/**
 * Canonical Nostr event-kind table shared by the Creaton web and desktop
 * apps. Mirrors `crates/buzz-core/src/kind.rs` — the Rust registry is the
 * protocol source of truth. Every registry integer is GENERATED into
 * `kinds.generated.ts` by `just regen-kinds` (drift-gated by
 * `node scripts/regen-kinds.mjs --check`); this module re-exports that table
 * and adds the hand-written entries below — client-only aliases (same wire
 * kind, distinguished by `d` tag) and grouped kind sets the registry does not
 * carry.
 *
 * Both apps re-export this module from their `shared/constants/kinds.ts`
 * shim. Values and names are wire format: never rename or renumber here
 * without changing the relay and the NIPs with it.
 */
import {
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_CONTRIBUTION_RECORD,
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  KIND_ORG_BUDGET,
  KIND_ORG_GRANT,
  KIND_ORG_NODE,
  KIND_ORG_PITCH,
  KIND_ORG_JOIN_REQUEST,
  KIND_SCORE_ROOT,
} from "./kinds.generated.ts";

export * from "./kinds.generated.ts";

// ── NIP-78 application data (all kind 30078, d-tag differentiated) ───────
// The relay differentiates them by d-tag ("read-state:<slotId>",
// "channel-sections", "channel-mutes", "channel-stars", "channel-sort",
// "project-sidebar-membership", "community-theme").
export const KIND_CHANNEL_SECTIONS = 30078;
export const KIND_CHANNEL_MUTES = 30078;
export const KIND_CHANNEL_STARS = 30078;
export const KIND_CHANNEL_SORT = 30078;
export const KIND_PROJECT_SIDEBAR_MEMBERSHIP = 30078;
export const KIND_COMMUNITY_THEME = 30078;

// ── Repos & projects (client aliases; not registry names) ─────────────────
export const KIND_REPO_ANNOUNCEMENT = 30617;
export const KIND_REPO_STATE = 30618;
/** NIP-MP: project grouping above NIP-34 repositories. */
export const KIND_PROJECT_ANNOUNCEMENT = 30621;

// ── Chat, channels (client aliases; not registry names) ───────────────────
export const KIND_CHANNEL_THREAD_SUMMARY = 39005;
export const KIND_CHANNEL_WINDOW_BOUNDS = 39006;
export const KIND_REMINDER = 40007;
export const KIND_APPROVAL_REQUEST = 46010;

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
