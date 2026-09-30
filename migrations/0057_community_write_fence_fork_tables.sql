-- creabuzz: put the fork's tenant tables under the community deletion fence.
--
-- 0045 (evm_identities) and 0047 (budget_consumption, budget_approvals) added
-- tables carrying community_id but never attached the universal write fence.
-- The whole-community deletion catalog (`EXPECTED_SCOPED_TABLES`) requires
-- exact equality between the live scoped tables and the fenced tables, so
-- with the fence missing every deletion request failed closed with
-- "community deletion catalog drift" (and, had it not, an in-flight write
-- could have resurrected budget or identity rows after the purge).
--
-- The Rust manifest (`crates/buzz-db/src/store/deletion.rs`) lists these
-- relations in the same change. Future migrations that add a table with
-- community_id must do the same: attach the fence here-style and update
-- EXPECTED_SCOPED_TABLES / PURGE_SCOPED_TABLES.

SELECT attach_community_write_fence('evm_identities');
SELECT attach_community_write_fence('budget_consumption');
SELECT attach_community_write_fence('budget_approvals');
