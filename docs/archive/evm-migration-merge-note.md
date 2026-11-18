# EVM identity migrations: merge note for `origin/main`

Status: open decision, recorded before the next merge of `origin/main` (`a138b8ba0`).

## The problem

Both lines independently added the same two migrations under different numbers:

| Branch | Files | Content |
|---|---|---|
| this branch (`dao-launchpad-rewrite`) | `migrations/0045_evm_identities.sql`, `0046_evm_revocation.sql` | `evm_identities`, `evm_revocations` tables |
| `origin/main` | `migrations/0027_evm_identities.sql`, `0028_evm_revocation.sql` | byte-identical (`diff` is empty) |

On this branch, versions 27 and 28 are already taken by unrelated migrations
(`0027_channels_id_lookup_index.sql`, `0028_long_reaction_payloads.sql`).

## Why it breaks

`crates/buzz-db/src/runtime/migration.rs` runs `sqlx::migrate!("../../migrations")`
with default settings. For an **already migrated** database, sqlx compares the
checksum of each applied version and returns `MigrateError::VersionMismatch`
when it differs (`sqlx-core-0.9.0/src/migrate/migrator.rs:275`). A merged tree
would therefore present version 27 with EVM content against a database that
applied version 27 with the channel-index content, and the relay would refuse to
start. Fresh databases fare no better: the directory would contain duplicate
migration versions.

## The fix

Keep this branch's `0045`/`0046` (they are the ones already applied here) and
**delete `origin/main`'s `0027_evm_identities.sql` and `0028_evm_revocation.sql`
during the merge** — they are identical in content, so nothing is lost. Do not
renumber this branch's copies, and do not renumber 27/28.

## Also

`origin/main` carries `tests/e2e_siwe.rs`, `evm_rotation.rs` (NIP-26), a desktop
Tauri `siwe.rs` and `scripts/siwe-demo.sh`; this branch has a paste-in subset of
that work with no E2E coverage. Reconcile those in the same merge rather than
keeping two implementations.
