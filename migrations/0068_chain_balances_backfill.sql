-- ── Chain reader running totals: fill them from the stored Transfers ─────────
-- Migration 0067 made chain_balances and chain_balance_changes empty, and the
-- reader stopped loading Shares Transfers with a project's logs at the same
-- time. On a database where the reader already ran, every free balance would
-- read 0 until new Transfers arrive (review I2). This fills the changes from
-- the Transfer rows already in chain_logs, with the reader's own rules (the
-- zero address is not an account; a transfer to oneself changes nothing),
-- then sets every balance to the sum of its changes. Data only, and safe to
-- run again: changes already kept are left alone, and balances are always the
-- sum of the changes kept.

INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, delta)
SELECT l.reader, l.block_number, l.log_index, m.account, l.project_key, m.delta
FROM chain_logs l
CROSS JOIN LATERAL (VALUES
    (decode(substr(lower(l.decoded->>'from'), 3), 'hex'), -((l.decoded->>'value')::numeric)),
    (decode(substr(lower(l.decoded->>'to'), 3), 'hex'), (l.decoded->>'value')::numeric)
) AS m(account, delta)
WHERE l.role = 'shares' AND l.event = 'Transfer'
  AND l.project_key IS NOT NULL
  AND l.decoded ? 'from' AND l.decoded ? 'to' AND l.decoded ? 'value'
  AND lower(l.decoded->>'from') <> lower(l.decoded->>'to')
  AND m.account <> '\x0000000000000000000000000000000000000000'::bytea
  AND NOT EXISTS (
      SELECT 1 FROM chain_balance_changes c
      WHERE c.reader = l.reader AND c.block_number = l.block_number AND c.log_index = l.log_index)
ON CONFLICT (reader, block_number, log_index, account) DO NOTHING;

INSERT INTO chain_balances (reader, project_key, account, balance)
SELECT reader, project_key, account, sum(delta)
FROM chain_balance_changes
GROUP BY reader, project_key, account
ON CONFLICT (reader, project_key, account) DO UPDATE SET balance = EXCLUDED.balance;

DELETE FROM chain_balances WHERE balance = 0;
