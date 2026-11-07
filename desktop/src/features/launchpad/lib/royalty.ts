/**
 * Shared with the web app: the pure royalty statement model (canonical
 * signatures, `cast sig` golden selectors, 32-byte word decoders, and the
 * statement math) lives in `@creaton/core/launchpad/royalty.ts`. The golden
 * vectors in `royalty.test.mjs` bind the shared implementation through this
 * re-export.
 *
 * Intentionally divergent twins stay per app: the UI-facing wrappers
 * (`RoyaltyStatementCard.tsx` and its read/send hooks) keep this app's own
 * chain seam (`chainRpc` decoders + the `evm_call` / `evm_send_transaction`
 * Tauri IPC commands) and are not unified with the web twins.
 */
export * from "@creaton/core/launchpad/royalty.ts";
