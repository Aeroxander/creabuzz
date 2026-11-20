-- ── Chain reader: how long money has stayed (step 3, STEP3-PLAN.md section 2) ──
-- The record's `held` key is each account's lowest balance over a window. It is counted by the database from this
-- project's balance changes inside the window, so two indexes make the read a range and not a scan, and five
-- columns keep what the ranking index needs beside the signed record they come from.
--
-- 1. This project's Share changes in block order from a block on, with the log's place inside the block, so the
--    window query reads them in order and stops at its row cap without sorting what it did not read.
-- 2. The first block after a time: the window's first block, one index step.
-- 3. The ranking columns of `chain_project_numbers`: what the signed record said about the money that stayed
--    (null when the record has none), written in the same statement that records the signing.
--
-- Public chain facts in operator-global tables: nothing here is community-scoped.

CREATE INDEX idx_chain_balance_changes_block
    ON chain_balance_changes (reader, project_key, token, block_number, log_index);

CREATE INDEX idx_chain_blocks_time ON chain_blocks (reader, block_time, number);

ALTER TABLE chain_project_numbers
    ADD COLUMN rank_money       NUMERIC(78, 0) CHECK (rank_money IS NULL OR rank_money >= 0),
    ADD COLUMN rank_accounts    INTEGER CHECK (rank_accounts IS NULL OR rank_accounts >= 0),
    ADD COLUMN rank_window_secs BIGINT CHECK (rank_window_secs IS NULL OR rank_window_secs >= 0),
    ADD COLUMN reached          BOOLEAN,
    ADD COLUMN launched_at      BIGINT CHECK (launched_at IS NULL OR launched_at >= 0);
