-- ── Chain reader running totals: bring back the emptied balances ───────────
-- Migration 0068 ended by deleting every balance of 0, and the reader's
-- rollback did the same. A rollback only subtracts from balances that exist,
-- so an account whose balance was 0 but had changes inside the rollback
-- window was left out after a reorg past those changes, and a balance read as
-- of an older final block missed it too. The reader now keeps zeros (reads
-- leave them out). This puts back a row for every account with kept changes
-- and no balance: the sum of its changes, as everywhere else. Data only, and
-- safe to run again: balances that exist are left alone.

INSERT INTO chain_balances (reader, project_key, account, balance)
SELECT reader, project_key, account, sum(delta)
FROM chain_balance_changes
GROUP BY reader, project_key, account
ON CONFLICT (reader, project_key, account) DO NOTHING;
