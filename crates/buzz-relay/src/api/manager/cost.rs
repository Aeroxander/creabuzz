//! What the hosted AI manager may spend (docs/PLAN-V2.md section 6 item 4 and 5), as definitions the code holds:
//!
//! - **Free while the founder posts weekly.** Before the project's first backing round closes with money in it, a
//!   hosted draft is served only while the founder posted a weekly update in the last 14 days, or the project record is
//!   younger than 14 days (a new project has had no week yet). Otherwise: "post this week's update first".
//! - **The hosted allowance starts when the first round closes.** From then on the posting rule no longer gates it.
//!   In both phases a project has at most `BUZZ_MANAGER_CALLS_PER_WEEK` hosted drafts in a week (fixed weeks from the
//!   Unix epoch, counted per project in `budget_consumption`); past it the answer is "run it as your own agent, with your
//!   own AI key" (`ai_manager_own_key`).
//! - **The platform's cap.** All hosted manager spend of the community over the last 90 days stays at or below 10% of
//!   the platform's fees over the same 90 days, read from the chain reader's tables (`chain_logs` with its blocks'
//!   times): every `toPlatform` of Rounds `Settled` and `Refunded`, Treasury `HandedBack` and the LiquidityHolder's
//!   `Collected`, and the Finisher's `raised - afterFee`. `FeesSwept` only moves fees already counted and is left out.
//!   Fees are in the dollar token's raw units (6 decimals): one raw unit is a tenth of a milli-cent. With no prices set
//!   the spend cannot be measured, so hosted drafts are refused. Only the configured chain reader's rows are read, so
//!   a second or re-made reader never counts a fee twice; with no chain reader there are no fees and no hosted drafts.
//! - **The operator's ceiling.** `BUZZ_MANAGER_MAX_CENTS_PER_90_DAYS`, when set, is a second limit in real money on
//!   the same 90 days of spend. It only ever narrows. A test network needs it: its fees are play dollars and the AI
//!   bill is not.
//!
//! The cap is held exactly, not checked and hoped for: a draft's worst cost is set aside under a lock before the
//! model is called ([`reserve_platform_spend`]) and corrected to what the call cost afterwards
//! ([`settle_platform_spend`]). If the correction is lost, the worst cost stays counted: the count can only err high.
//!
//! Scope, plainly: the chain reader's fees are the operator's (one set of contracts, every community), while the spend
//! is counted per community. A server with one community, the plan's case, measures the same thing on both sides.
//! With no fees in the last 90 days the cap is zero and every hosted draft is refused: the plan read literally. Whether
//! a new server should have a small fixed floor is the owner's decision (see the milestone 8 report), not this code's.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use buzz_core::tenant::CommunityId;

/// The share of fees the platform may spend on the hosted manager, in percent.
pub(crate) const FEE_SHARE_PERCENT: u128 = 10;
/// The window fees and spend are both measured over.
pub(crate) const WINDOW_DAYS: i64 = 90;
/// How recent the founder's weekly update must be for a free draft before the first round closes.
pub(crate) const POSTED_WITHIN_DAYS: i64 = 14;

const WEEK_SECS: i64 = 7 * 86_400;
const DAY_SECS: i64 = 86_400;
const CALLS_COUNTER: &str = "manager_calls";
const SPEND_COUNTER: &str = "manager_spend_mc";
const SPEND_SUBJECT: &str = "manager-platform";

/// The start of the fixed week (from the Unix epoch) that holds `now`.
pub(crate) fn week_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let t = now.timestamp();
    DateTime::from_timestamp(t - t.rem_euclid(WEEK_SECS), 0).unwrap_or(now)
}

fn day_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let t = now.timestamp();
    DateTime::from_timestamp(t - t.rem_euclid(DAY_SECS), 0).unwrap_or(now)
}

/// The counter row a project's weekly drafts are kept under: short and fixed-size whatever the project's address, and
/// one row whatever the case its founder's key was typed in (`37001:<key>:<id>`: the key is hex, the id is exact).
pub(crate) fn project_subject(coordinate: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut parts = coordinate.splitn(3, ':');
    let normal = match (parts.next(), parts.next(), parts.next()) {
        (Some(kind), Some(author), Some(id)) => format!("{kind}:{}:{id}", author.to_lowercase()),
        _ => coordinate.to_string(),
    };
    format!(
        "manager:{}",
        hex::encode(&Sha256::digest(normal.as_bytes())[..20])
    )
}

/// The id the chain knows a project by: the hash of its record's address (`Launcher.launch`'s `projectId`), as the
/// reader's logs write it.
pub(crate) fn project_id(coordinate: &str) -> String {
    format!(
        "0x{}",
        hex::encode(buzz_evm_allowance::abi::keccak256(coordinate.as_bytes()))
    )
}

const FIRST_SEEN_COUNTER: &str = "manager_first_seen";

/// When this project first asked the manager, in Unix seconds: noted on the first call and never moved. The project's
/// record is replaceable, so its own date can be reset by saving it again; this cannot.
pub(crate) async fn first_seen(
    pool: &PgPool,
    community: CommunityId,
    coordinate: &str,
    now: DateTime<Utc>,
) -> Result<i64, sqlx::Error> {
    let epoch = DateTime::from_timestamp(0, 0).unwrap_or(now);
    sqlx::query(
        "INSERT INTO budget_consumption (community_id, subject, counter_type, window_start, consumed) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (community_id, subject, counter_type, window_start) DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(project_subject(coordinate))
    .bind(FIRST_SEEN_COUNTER)
    .bind(epoch)
    .bind(now.timestamp().max(0))
    .execute(pool)
    .await?;
    let seen: Option<i64> = sqlx::query_scalar(
        "SELECT consumed FROM budget_consumption \
         WHERE community_id = $1 AND subject = $2 AND counter_type = $3 AND window_start = $4",
    )
    .bind(community.as_uuid())
    .bind(project_subject(coordinate))
    .bind(FIRST_SEEN_COUNTER)
    .bind(epoch)
    .fetch_optional(pool)
    .await?;
    Ok(seen.unwrap_or_else(|| now.timestamp()))
}

/// Count one hosted draft for the project this week, unless it already had `limit`. Atomic: two drafts at once never
/// both take the last one. True when it was counted.
pub(crate) async fn take_weekly_call(
    pool: &PgPool,
    community: CommunityId,
    coordinate: &str,
    limit: u32,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO budget_consumption (community_id, subject, counter_type, window_start, consumed) \
         VALUES ($1, $2, $3, $4, 1) \
         ON CONFLICT (community_id, subject, counter_type, window_start) \
         DO UPDATE SET consumed = budget_consumption.consumed + 1, updated_at = now() \
         WHERE budget_consumption.consumed < $5 \
         RETURNING consumed",
    )
    .bind(community.as_uuid())
    .bind(project_subject(coordinate))
    .bind(CALLS_COUNTER)
    .bind(week_start(now))
    .bind(i64::from(limit))
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some() && limit > 0)
}

/// Give back a draft counted by [`take_weekly_call`] that the AI service never answered: the founder got nothing and
/// the platform paid nothing. Never below zero.
pub(crate) async fn return_weekly_call(
    pool: &PgPool,
    community: CommunityId,
    coordinate: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE budget_consumption SET consumed = consumed - 1, updated_at = now() \
         WHERE community_id = $1 AND subject = $2 AND counter_type = $3 AND window_start = $4 AND consumed > 0",
    )
    .bind(community.as_uuid())
    .bind(project_subject(coordinate))
    .bind(CALLS_COUNTER)
    .bind(week_start(now))
    .execute(pool)
    .await?;
    Ok(())
}

/// The community's hosted manager spend over the last [`WINDOW_DAYS`], in milli-cents (drafts in flight counted at
/// their worst cost).
pub(crate) async fn platform_spent<'e>(
    db: impl sqlx::PgExecutor<'e>,
    community: CommunityId,
    now: DateTime<Utc>,
) -> Result<u128, sqlx::Error> {
    let since = day_start(now) - chrono::Duration::days(WINDOW_DAYS);
    let total: Option<i64> = sqlx::query_scalar(
        "SELECT SUM(consumed)::bigint FROM budget_consumption \
         WHERE community_id = $1 AND subject = $2 AND counter_type = $3 AND window_start >= $4",
    )
    .bind(community.as_uuid())
    .bind(SPEND_SUBJECT)
    .bind(SPEND_COUNTER)
    .bind(since)
    .fetch_one(db)
    .await?;
    Ok(u128::try_from(total.unwrap_or(0)).unwrap_or(0))
}

/// Set aside the most one draft can cost (`worst` milli-cents) on today's row, if that keeps the community's spend
/// within its share of `fees` and under the operator's `ceiling`. One community's reservations are taken one at a time
/// (a transaction-scoped advisory lock), so drafts asked for at once can never pass the cap together. True when set
/// aside; the caller then calls the model and [`settle_platform_spend`].
pub(crate) async fn reserve_platform_spend(
    pool: &PgPool,
    community: CommunityId,
    worst: u64,
    fees: u128,
    ceiling: Option<u128>,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("manager_spend:{}", community.as_uuid()))
        .execute(&mut *tx)
        .await?;
    let spent = platform_spent(&mut *tx, community, now).await?;
    if !within_platform_cap(spent, fees, u128::from(worst), ceiling) {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO budget_consumption (community_id, subject, counter_type, window_start, consumed) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (community_id, subject, counter_type, window_start) \
         DO UPDATE SET consumed = budget_consumption.consumed + EXCLUDED.consumed, updated_at = now()",
    )
    .bind(community.as_uuid())
    .bind(SPEND_SUBJECT)
    .bind(SPEND_COUNTER)
    .bind(day_start(now))
    .bind(i64::try_from(worst).unwrap_or(i64::MAX))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// Correct a reservation of `worst` to what the call cost (`actual`), on the row the reservation was made on (the
/// same `now`). A call that never answered cost nothing. Never below zero.
pub(crate) async fn settle_platform_spend(
    pool: &PgPool,
    community: CommunityId,
    worst: u64,
    actual: u64,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let change = i128::from(actual) - i128::from(worst);
    if change == 0 {
        return Ok(());
    }
    sqlx::query(
        "UPDATE budget_consumption SET consumed = GREATEST(consumed + $5, 0), updated_at = now() \
         WHERE community_id = $1 AND subject = $2 AND counter_type = $3 AND window_start = $4",
    )
    .bind(community.as_uuid())
    .bind(SPEND_SUBJECT)
    .bind(SPEND_COUNTER)
    .bind(day_start(now))
    .bind(i64::try_from(change).unwrap_or(if change > 0 { i64::MAX } else { i64::MIN }))
    .execute(pool)
    .await?;
    Ok(())
}

/// The platform's fees over the last [`WINDOW_DAYS`], in milli-cents, from the configured chain reader's rows
/// (`reader` is its name in the tables). No reader, no fees.
pub(crate) async fn platform_fees(
    pool: &PgPool,
    reader: Option<&str>,
    now: DateTime<Utc>,
) -> Result<u128, sqlx::Error> {
    let Some(reader) = reader else {
        return Ok(0);
    };
    let since = now.timestamp() - WINDOW_DAYS * DAY_SECS;
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT SUM(CASE \
             WHEN l.role = 'rounds' AND l.event IN ('Settled', 'Refunded') THEN (l.decoded->>'toPlatform')::numeric \
             WHEN l.role = 'treasury' AND l.event = 'HandedBack' THEN (l.decoded->>'toPlatform')::numeric \
             WHEN l.role = 'holder' AND l.event = 'Collected' THEN (l.decoded->>'toPlatform')::numeric \
             WHEN l.role = 'finisher' AND l.event = 'Settled' \
                  THEN (l.decoded->>'raised')::numeric - (l.decoded->>'afterFee')::numeric \
             ELSE 0 END)::text \
         FROM chain_logs l JOIN chain_blocks b ON b.reader = l.reader AND b.number = l.block_number \
         WHERE l.reader = $2 AND b.block_time >= $1 AND l.decoded IS NOT NULL",
    )
    .bind(since)
    .bind(reader)
    .fetch_one(pool)
    .await?;
    // Raw dollar units (6 decimals) to milli-cents: one raw unit is a ten-thousandth of a cent.
    let raw = raw
        .as_deref()
        .and_then(|value| value.split('.').next())
        .and_then(|whole| whole.parse::<u128>().ok())
        .unwrap_or(0);
    Ok(raw / 10)
}

/// Whether one more draft costing at most `next` milli-cents keeps the platform's spend at or below its share of fees,
/// and at or below the operator's `ceiling` in real money when one is set.
pub(crate) fn within_platform_cap(
    spent: u128,
    fees: u128,
    next: u128,
    ceiling: Option<u128>,
) -> bool {
    let after = spent.saturating_add(next);
    after.saturating_mul(100) <= fees.saturating_mul(FEE_SHARE_PERCENT)
        && ceiling.is_none_or(|most| after <= most)
}

/// Whether the project's first backing round closed with money in it, by the configured chain reader's logs for its
/// chain key, and only when its launch log names this very project: a `ProjectLaunched` for `chain_key` whose
/// `projectId` is `project_id` (the hash of the record's address). A record that names another project's key, or a
/// launch made for someone else's record, shows no round. No reader, no round.
pub(crate) async fn first_round_closed(
    pool: &PgPool,
    reader: Option<&str>,
    chain_key: &[u8; 32],
    project_id: &str,
) -> Result<bool, sqlx::Error> {
    let Some(reader) = reader else {
        return Ok(false);
    };
    let found = sqlx::query(
        "SELECT 1 WHERE EXISTS (SELECT 1 FROM chain_logs WHERE reader = $1 AND project_key = $2 \
             AND role = 'launcher' AND event = 'ProjectLaunched' AND lower(decoded->>'projectId') = $3) \
         AND EXISTS (SELECT 1 FROM chain_logs WHERE reader = $1 AND project_key = $2 AND role = 'rounds' \
             AND event = 'RoundClosed' AND (decoded->>'accepted')::numeric > 0)",
    )
    .bind(reader)
    .bind(chain_key.as_slice())
    .bind(project_id.to_lowercase())
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_spends_at_most_a_tenth_of_its_fees() {
        // 1,000 dollars of fees is 100,000 cents: 10,000 cents (10,000,000 milli-cents) may be spent.
        let fees = 100_000 * 1_000;
        assert!(within_platform_cap(9_999_000, fees, 1_000, None));
        assert!(!within_platform_cap(9_999_000, fees, 1_001, None));
        assert!(
            !within_platform_cap(0, 0, 1, None),
            "no fees, no hosted spend"
        );
        assert!(within_platform_cap(0, 0, 0, None));
    }

    #[test]
    fn the_operators_ceiling_only_narrows() {
        // Play-dollar fees of a million dollars would allow 100,000 dollars of real spend: the ceiling says 5 dollars.
        let play_fees = 100_000_000 * 1_000;
        let five_dollars = Some(500 * 1_000);
        assert!(within_platform_cap(0, play_fees, 600_000, None));
        assert!(!within_platform_cap(0, play_fees, 600_000, five_dollars));
        assert!(within_platform_cap(
            400_000,
            play_fees,
            100_000,
            five_dollars
        ));
        assert!(!within_platform_cap(
            400_000,
            play_fees,
            100_001,
            five_dollars
        ));
        // A ceiling never lifts the fee cap.
        assert!(!within_platform_cap(0, 0, 1, five_dollars));
    }

    #[test]
    fn weeks_are_fixed_and_a_project_has_one_row() {
        let monday_noon = DateTime::from_timestamp(1_800_000_000, 0).expect("time");
        let start = week_start(monday_noon);
        assert_eq!(start.timestamp() % WEEK_SECS, 0);
        assert!(start <= monday_noon && monday_noon - start < chrono::Duration::days(7));
        let subject = project_subject(&format!("37001:{}:{}", "f".repeat(64), "x".repeat(200)));
        assert!(subject.len() <= 128, "fits the counter's column");
        assert_ne!(subject, project_subject("37001:other"));
    }
}
