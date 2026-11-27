//! Test-only barriers for NIP-FI B2 witness tests.
//!
//! Each function is a named production hook that is inert in production
//! (`#[cfg(test)]` guards ensure zero-cost at runtime) but acts as a
//! deterministic barrier in tests. A test arms the gate, dispatches work,
//! waits for the arrived notification, fires expiry, then releases the gate.
//!
//! Pattern (same as `publish_test_hooks` in `side_effects.rs`):
//! - `arm(community)` → `(arrived_rx, release_notify)`
//! - Production code calls `before_X(community).await`
//! - Test awaits `arrived_rx.await` → knows production reached the hook
//! - Test fires expiry
//! - Test calls `release_notify.notify_one()` → production proceeds
//!
//! Only one gate per community-slot is supported at a time (static Mutex<HashMap>).
//! Tests using different communities can run concurrently — each gets its own gate.
//! Tests using the same community must not run concurrently (they will interfere).
//!
//! # Per-witness mutation-red table
//!
//! Every witness listed below follows the same structure:
//!
//! | Witness | Hook location (production file:line) | One-line mutation | Failing assertion |
//! |---------|--------------------------------------|-------------------|-------------------|
//! | **W1** (auth barrier) | `handlers/auth.rs` — immediately before `acquire_effect()`, ahead of NIP-OA materialization and the AUTH commit | Delete `before_auth_commit(...)` call | `arrived_rx` times out → test panics |
//! | **W1** (auth barrier) | same | Remove `acquire_effect()` from auth.rs | `auth_state is NOT Authenticated` → assertion panics |
//! | **W1** (auth barrier) | same | Change gate to `off_mode` | same as above |
//! | **W2** (event barrier) | `handlers/event.rs:784` — immediately before `acquire_effect()` in event ingest path | Delete `before_event_ingest(...)` call | `arrived_rx` times out → test panics |
//! | **W2** (event barrier) | same | Remove `acquire_effect()` from event.rs | "session expired" OK(false) not sent → first `try_recv` panics |
//! | **W2** (event barrier) | same | Change gate to `off_mode` | same as above |
//! | **W3** (REQ barrier) | `handlers/req.rs:280` — immediately before `acquire_effect()` in REQ path | Delete `before_req_registration(...)` call | `arrived_rx` times out → test panics |
//! | **W3** (REQ barrier) | same | Remove `acquire_effect()` from req.rs | subscription IS inserted → `subs.is_empty()` panics |
//! | **W3** (REQ barrier) | same | Change gate to `off_mode` | same as above |
//! | **W4** (COUNT barrier) | `handlers/count.rs:112` — immediately before `acquire_effect()` in COUNT path | Delete `before_count_query(...)` call | `arrived_rx` times out → test panics |
//! | **W4** (COUNT barrier) | same | Remove `acquire_effect()` from count.rs | CLOSED message changes from "session expired" → assertion panics |
//! | **W4** (COUNT barrier) | same | Change gate to `off_mode` | no CLOSED sent → `try_recv` returns `Err` → assertion panics |
//! | **P1-b** (agent-observer EVENT barrier) | `handlers/event.rs` — immediately before `acquire_effect()` in `KIND_AGENT_OBSERVER_FRAME` branch | Delete `before_observer_event(...)` call | `arrived_rx` times out → test panics |
//! | **P1-b** (agent-observer EVENT barrier) | same | Remove `acquire_effect()` from observer branch | handler proceeds to fan-out → OK(true, "") sent → `t.contains("session expired")` assertion panics |
//!
//! # Teardown ordering (quiescence citations)
//!
//! The quiescence requirement from the contract (e5bc0382): the expiry task must complete
//! (i.e., acquire and release the write guard after cancellation) before subscription/peer
//! cleanup runs. This prevents post-`remove_connection` subscription leaks.
//!
//! **Root WS** (`connection.rs:449-453`):
//! ```text
//! if let Some(task) = nip_fi_expiry_task { let _ = task.await; }  // line 449
//! for removed in state.sub_registry.remove_connection(...)  // line 453 — after expiry
//! ```
//!

use buzz_core::CommunityId;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::{oneshot, Notify};

struct Gate {
    arrived: oneshot::Sender<()>,
    release: Arc<Notify>,
}

macro_rules! make_hook {
    ($mod_name:ident, $fn_name:ident) => {
        pub(crate) mod $mod_name {
            use super::*;

            // Keyed by CommunityId so concurrent tests with different communities
            // can arm independent gates without overwriting each other.
            static GATE: LazyLock<Mutex<HashMap<CommunityId, Gate>>> =
                LazyLock::new(|| Mutex::new(HashMap::new()));

            /// Arm a one-shot barrier for `community`.
            ///
            /// Returns `(arrived_rx, release)`. Await `arrived_rx` to know when
            /// the production code has reached this hook; call `release.notify_one()`
            /// to let it continue.
            pub(crate) fn arm(community: CommunityId) -> (oneshot::Receiver<()>, Arc<Notify>) {
                let (tx, rx) = oneshot::channel();
                let release = Arc::new(Notify::new());
                GATE.lock().unwrap().insert(
                    community,
                    Gate {
                        arrived: tx,
                        release: release.clone(),
                    },
                );
                (rx, release)
            }

            pub(crate) async fn trigger(community: CommunityId) {
                let gate = GATE.lock().unwrap().remove(&community);
                if let Some(g) = gate {
                    let _ = g.arrived.send(());
                    g.release.notified().await;
                }
            }
        }

        pub(crate) async fn $fn_name(community: CommunityId) {
            $mod_name::trigger(community).await;
        }
    };
}

make_hook!(auth_commit_hook, before_auth_commit);
make_hook!(event_ingest_hook, before_event_ingest);
make_hook!(req_registration_hook, before_req_registration);
make_hook!(count_query_hook, before_count_query);
make_hook!(observer_event_hook, before_observer_event);
// `before_req_history` / `before_search_query`: fire inside the read-only
// delivery raced against gate cancellation in `handle_req`, after the permit
// (and, for REQ, registration). Stalling here stands in for a stalled read.
make_hook!(req_history_hook, before_req_history);
make_hook!(search_query_hook, before_search_query);

// `before_git_membership`: fires in the Git transport after NIP-FI admission,
// immediately before the relay membership lookup. Closing the pool here makes
// that lookup fail with the tenant already bound.
make_hook!(git_membership_hook, before_git_membership);

// ── Deny-set admission hooks ───────────────────────────────────────────────
// `before_deny_set_check`: fires in the root WS auth handler after the proven
// identity is registered and before `is_denied`, so a straddle witness can
// insert a deny entry in that window.  [FI-TRACE-DENY-SET]
make_hook!(deny_set_check_hook, before_deny_set_check);

// `handlers/auth.rs::admitted_owner`, after the stored-owner read returns and
// before the caller records it. A test links the owner here to race admission.
make_hook!(stored_owner_read_hook, after_stored_owner_read);

// ── Publication-attempt counter ────────────────────────────────────────────
// `before_event_publish`: fires immediately before `state.pubsub.publish_event`
// in `dispatch_persistent_event_inner`. Used by W2: after handle_event returns
// under session-expired, assert this counter is 0 — proves `publish_event` was
// never called (real publication boundary, not a proxy).
//
// Mutation evidence (W2):
//   Remove `acquire_effect()` from event.rs → ingest_event is called →
//   dispatch_persistent_event_inner runs → before_event_publish fires →
//   counter = 1 → `assert_eq!(publish_count, 0)` panics.
pub(crate) mod event_publish_counter {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTERS: LazyLock<Mutex<HashMap<CommunityId, Arc<AtomicU32>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Register a counter for `community` and return it. The counter starts at 0
    /// and is incremented each time `before_event_publish` fires for this community.
    pub(crate) fn register(community: CommunityId) -> Arc<AtomicU32> {
        let counter = Arc::new(AtomicU32::new(0));
        COUNTERS.lock().unwrap().insert(community, counter.clone());
        counter
    }

    /// Deregister the counter for `community` (call after the test assertion).
    pub(crate) fn deregister(community: CommunityId) {
        COUNTERS.lock().unwrap().remove(&community);
    }

    pub(crate) fn increment(community: CommunityId) {
        if let Some(counter) = COUNTERS.lock().unwrap().get(&community) {
            counter.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(crate) fn before_event_publish(community: CommunityId) {
    event_publish_counter::increment(community);
}
