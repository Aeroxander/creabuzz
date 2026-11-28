//! Tying the chain's helper limits to the server's labels (open item 4 of `docs/archive/PLANV2-M8-REPORT.md`).
//!
//! A helper's daily limits bind an **address** on the network (`Treasury.setAgent`); the labels the server keeps bind a
//! Nostr **account** (`agent_label`). The one link the server has is the wallet binding (`wallet_binding`: an account
//! proves control of a wallet by signature). Where an account has linked a wallet that the network shows as a live helper
//! of a project, three rules close the gaps the missing link left. All three read only stored rows (the wallet bindings and
//! the chain reader's `chain_logs`), make no call to a node, refuse at write time, and say how to clear the refusal. A read
//! that fails is a server fault and refuses the write.
//!
//! 1. A profile that writes `agent-role = manager` is refused when any wallet the account has linked is a live helper in
//!    any project this reader follows (a manager account must be distinct from the helpers that have limits).
//! 2. A task step signed by an account that is not labelled a helper, whose linked wallet is a live helper of **that**
//!    project, is refused until the account is labelled (a team key that is a helper on the network but has no label).
//!    A wallet an account never linked stays a stated limit.
//! 3. A helper-labelled account that posts an open task whose linked wallet is a live helper of that project may offer at
//!    most that helper's daily dollar limit (it was held to the server's cap alone, 100,000 dollars).
//!
//! "Live" is what the events say: the helper's last `AgentSet` switched it on, and no change of runner came after it (a
//! change of runner switches every helper off without an event of their own).

use std::sync::Arc;

use buzz_core::tenant::CommunityId;
use nostr::Event;
use sqlx::PgPool;

use super::ingest::IngestError;
use super::launch_update_authority::internal;
use super::wallet_binding::{all_linked_wallets, wallet_text, AllWallets, Wallet};
use crate::state::AppState;

/// Said on a manager profile whose account has linked a wallet that is a live helper on the network (rule 1).
pub(crate) const MANAGER_HAS_LIMITS: &str = "invalid: a manager account cannot also be a helper with spending limits on the network; unlink that wallet from this account to clear this";
/// Said on a task step by an unlabelled account whose linked wallet is a live helper of the project (rule 2).
pub(crate) const UNLABELLED_HELPER: &str = "restricted: this wallet is set as a helper on the network; label this account as a helper, or unlink the wallet from this account, to clear this";
/// Said on an open task above what the network lets the signer's helper wallet spend in a day (rule 3).
pub(crate) const ABOVE_HELPER_LIMIT: &str = "invalid: that is more than the daily limit the network gives the helper that uses this account's wallet; offer less, or unlink that wallet from this account, to clear this";

/// Said when an account has linked more wallets than can be read at once, so the network cannot be asked about all of them.
pub(crate) const TOO_MANY_WALLETS: &str = "invalid: this account has linked more wallets than the server can check against the helpers on the network; use another account for this";

/// The most helper rows read for one account's wallets.
const LIVE_READ: i64 = 64;
/// Dollars are kept in millionths (6 decimals), as the Treasury's `AgentSet` says them.
const DOLLAR_RAW: u128 = 1_000_000;

/// A wallet the network shows as a live helper of one project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveHelper {
    /// The project's chain key.
    pub(crate) project_key: [u8; 32],
    /// Its daily dollar limit (raw dollars).
    pub(crate) usd_cap: u128,
}

/// The helpers among `$2` (lower-case `0x` wallets) that are live, in one project (`$3`) or in all (`NULL`), as the
/// reader's stored rows say: the newest `AgentSet` of each wallet in each project, kept when it switched the helper on and
/// no `RunnerChanged` of that project came after it. Served by `idx_chain_logs_agent_set` (migration 0076).
pub(crate) const LIVE_HELPERS_SQL: &str = "\
SELECT a.project_key, a.decoded->>'usdCap' \
FROM (SELECT DISTINCT ON (project_key, lower(decoded->>'agent')) project_key, decoded, block_number, log_index \
        FROM chain_logs \
       WHERE reader = $1 AND role = 'treasury' AND event = 'AgentSet' AND project_key IS NOT NULL \
         AND lower(decoded->>'agent') = ANY($2) AND ($3::bytea IS NULL OR project_key = $3) \
       ORDER BY project_key, lower(decoded->>'agent'), block_number DESC, log_index DESC) a \
WHERE (a.decoded->>'active')::boolean \
  AND NOT EXISTS (SELECT 1 FROM chain_logs r \
                   WHERE r.reader = $1 AND r.project_key = a.project_key \
                     AND r.role = 'treasury' AND r.event = 'RunnerChanged' \
                     AND (r.block_number, r.log_index) > (a.block_number, a.log_index)) \
LIMIT $4";

/// The live helpers among `wallets`, in `project` or in every project the reader follows.
pub(crate) async fn live_helpers(
    pool: &PgPool,
    reader: &str,
    wallets: &[Wallet],
    project: Option<&[u8; 32]>,
) -> Result<Vec<LiveHelper>, sqlx::Error> {
    if wallets.is_empty() {
        return Ok(Vec::new());
    }
    let asked: Vec<String> = wallets.iter().map(wallet_text).collect();
    let rows: Vec<(Vec<u8>, Option<String>)> = sqlx::query_as(LIVE_HELPERS_SQL)
        .bind(reader)
        .bind(asked)
        .bind(project.map(|key| key.to_vec()))
        .bind(LIVE_READ)
        .fetch_all(pool)
        .await?;
    rows.into_iter()
        .map(|(key, cap)| {
            let project_key = <[u8; 32]>::try_from(key.as_slice())
                .map_err(|_| sqlx::Error::Decode("a stored project key is not 32 bytes".into()))?;
            let usd_cap = cap
                .and_then(|text| text.parse::<u128>().ok())
                .ok_or_else(|| sqlx::Error::Decode("a stored helper has no `usdCap`".into()))?;
            Ok(LiveHelper {
                project_key,
                usd_cap,
            })
        })
        .collect()
}

/// Rule 1: a manager account has no live helper wallet.
pub(crate) fn decide_manager(live: &[LiveHelper]) -> Result<(), &'static str> {
    if live.is_empty() {
        Ok(())
    } else {
        Err(MANAGER_HAS_LIMITS)
    }
}

/// Rules 2 and 3 for a task step signed in a project whose helpers `live` are (the signer's linked wallets that are live
/// helpers of that project). `labelled` is whether the signer is on record as a helper account; `open_task_usd` is what
/// the step offers, in whole dollars, when it is a task open to anyone.
pub(crate) fn decide_step(
    live: &[LiveHelper],
    labelled: bool,
    open_task_usd: Option<u64>,
) -> Result<(), &'static str> {
    if live.is_empty() {
        return Ok(());
    }
    if !labelled {
        return Err(UNLABELLED_HELPER);
    }
    // The smallest limit among the signer's live helper wallets binds: any of them could pay the task.
    let limit = live.iter().map(|helper| helper.usd_cap).min();
    match (open_task_usd, limit) {
        (Some(usd), Some(limit)) if u128::from(usd) * DOLLAR_RAW > limit => Err(ABOVE_HELPER_LIMIT),
        _ => Ok(()),
    }
}

/// An account whose records were not all read cannot be shown to hold no live helper wallet: it is refused (rules 1
/// and 2 never trust an account that links more wallets than a read holds).
pub(crate) fn decide_complete(all: &AllWallets) -> Result<(), &'static str> {
    if all.complete {
        Ok(())
    } else {
        Err(TOO_MANY_WALLETS)
    }
}

/// Rule 1 on a manager's profile: refuse it when a wallet the account has linked is a live helper anywhere.
pub(crate) async fn enforce_manager(
    state: &Arc<AppState>,
    community: CommunityId,
    event: &Event,
) -> Result<(), IngestError> {
    let Some(reader) = reader_of(state) else {
        return Ok(());
    };
    let all = all_linked_wallets(state, community, &event.pubkey.to_bytes())
        .await
        .map_err(|e| internal("reading the wallets the account linked", e))?;
    let live = live_helpers(state.db.pool(), &reader, &all.wallets, None)
        .await
        .map_err(|e| internal("reading the helpers on the network", e))?;
    decide_manager(&live)
        .and_then(|()| decide_complete(&all))
        .map_err(|reason| IngestError::Rejected(reason.into()))
}

/// Rules 2 and 3 on a task step: `signer` writes `event` in the project whose chain key is `key`.
pub(crate) async fn enforce_step(
    state: &Arc<AppState>,
    community: CommunityId,
    key: &[u8; 32],
    event: &Event,
    open_task_usd: Option<u64>,
) -> Result<(), IngestError> {
    let Some(reader) = reader_of(state) else {
        return Ok(());
    };
    let signer = event.pubkey.to_bytes();
    let all = all_linked_wallets(state, community, &signer)
        .await
        .map_err(|e| internal("reading the wallets the account linked", e))?;
    // A read that stopped short may have missed a helper wallet: an account cannot hide one among throwaway wallets.
    decide_complete(&all).map_err(|reason| IngestError::Rejected(reason.into()))?;
    if all.wallets.is_empty() {
        return Ok(());
    }
    let live = live_helpers(state.db.pool(), &reader, &all.wallets, Some(key))
        .await
        .map_err(|e| internal("reading the helpers on the network", e))?;
    if live.is_empty() {
        return Ok(());
    }
    let labelled =
        super::launch_update_authority::is_agent_account(state, community, &signer).await?;
    decide_step(&live, labelled, open_task_usd).map_err(|reason| {
        if reason.starts_with("restricted:") {
            IngestError::AuthFailed(reason.into())
        } else {
            IngestError::Rejected(reason.into())
        }
    })
}

fn reader_of(state: &AppState) -> Option<String> {
    state
        .config
        .chain_reader
        .as_ref()
        .map(|reader| reader.reader_id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn helper(cap_dollars: u128) -> LiveHelper {
        LiveHelper {
            project_key: [7; 32],
            usd_cap: cap_dollars * DOLLAR_RAW,
        }
    }

    #[test]
    fn a_manager_with_a_live_helper_wallet_is_refused_and_one_without_is_not() {
        assert_eq!(decide_manager(&[]), Ok(()));
        assert_eq!(decide_manager(&[helper(25)]), Err(MANAGER_HAS_LIMITS));
    }

    #[test]
    fn an_unlabelled_account_with_a_live_helper_wallet_is_refused_a_labelled_one_is_not() {
        assert_eq!(decide_step(&[], false, None), Ok(()));
        assert_eq!(
            decide_step(&[helper(25)], false, None),
            Err(UNLABELLED_HELPER)
        );
        assert_eq!(decide_step(&[helper(25)], true, None), Ok(()));
    }

    #[test]
    fn an_open_task_is_held_to_the_smallest_daily_limit_of_the_signers_helper_wallets() {
        let live = [helper(40), helper(25)];
        assert_eq!(decide_step(&live, true, Some(25)), Ok(()));
        assert_eq!(decide_step(&live, true, Some(26)), Err(ABOVE_HELPER_LIMIT));
        // A signer with no live helper wallet is not held to any limit here (the server's own cap still stands).
        assert_eq!(decide_step(&[], true, Some(100_000)), Ok(()));
        // A step that offers nothing is not an open task.
        assert_eq!(decide_step(&[helper(1)], true, None), Ok(()));
    }

    #[test]
    fn every_refusal_says_how_to_clear_it() {
        for words in [MANAGER_HAS_LIMITS, UNLABELLED_HELPER, ABOVE_HELPER_LIMIT] {
            assert!(words.contains("unlink"), "{words}");
        }
        // Too many linked wallets cannot be cleared by unlinking (a revoked record cannot be removed): it says what works.
        assert!(TOO_MANY_WALLETS.contains("use another account"));
        assert!(!TOO_MANY_WALLETS.contains("unlink"));
        assert!(UNLABELLED_HELPER.contains("label this account"));
    }
}
