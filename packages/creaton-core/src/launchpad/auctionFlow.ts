/**
 * Pure founder money-loop logic — FLOW half: the deploy state machine (reducer),
 * the retry plan, and the deploy orchestrator, split across
 * `auctionDeployState.ts` (state machine) and `auctionDeployRun.ts` (effects
 * runner). The effect ports, constants, parameter gate, config encoding and
 * factory calls are in `auctionPlan.ts` and re-exported from here, so this
 * stays the one import site for the flow (and the desktop test suite ports over
 * byte-identical). See `auctionPlan.ts` for the sources of truth every layout
 * is checked against.
 */

export * from "./auctionPlan.ts";
export * from "./auctionDeployState.ts";
export * from "./auctionDeployRun.ts";
