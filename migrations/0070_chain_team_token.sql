-- ── Chain reader: the Team token's role, Team Share balances, the helper's call names ──
-- The reader on contracts/pot follows two Share tokens per project: backer
-- Shares and Team Shares. Until now the database could not say so: the Team
-- token was stored as role 'shares' (told apart through the project's launch
-- row), Team Share balances were kept under a key derived from the project's
-- key, and the helper's two calls kept the names of calls that no longer
-- exist. This makes each of them a plain fact.
--
-- 1. chain_contracts.role may be 'team'; each project's Team token is moved
--    to it (it is the address its own ProjectLaunched row names as `team`).
-- 2. chain_balances and chain_balance_changes get a token column ('shares' or
--    'team') and keep the project's real key. Change rows of Team Transfers
--    move from the derived key to the real one; missing ones are added the way
--    migration 0068 added the backer Shares'; every balance is then rebuilt as
--    the sum of its changes, which is what it always is (0068, 0069).
-- 3. chain_helper_jobs.call may be 'treasury.collectFees' and 'treasury.settle'.
--    Rows of a reader that follows contracts/pot (it has a Team token) are
--    renamed from the names they were stored under ('treasury.sweepFees',
--    'treasury.release'); other readers' rows are history of the old contracts'
--    calls and keep their names, which stay allowed.
--
-- Public chain facts in operator-global tables: nothing here is community-scoped.

-- 1. The Team token's role.
ALTER TABLE chain_contracts DROP CONSTRAINT chain_contracts_role_check;
ALTER TABLE chain_contracts ADD CONSTRAINT chain_contracts_role_check CHECK (role IN
    ('launcher', 'shares', 'team', 'treasury', 'vester', 'finisher', 'rounds', 'pair',
     'earlier', 'auction', 'holder', 'pool_manager'));

UPDATE chain_contracts c SET role = 'team'
WHERE c.role = 'shares'
  AND EXISTS (
      SELECT 1 FROM chain_logs l
      WHERE l.reader = c.reader AND l.project_key = c.project_key
        AND l.role = 'launcher' AND l.event = 'ProjectLaunched'
        AND l.decoded->'project'->>'team' = '0x' || encode(c.address, 'hex'));

-- 2. Balances by token.
ALTER TABLE chain_balance_changes
    ADD COLUMN token TEXT NOT NULL DEFAULT 'shares' CHECK (token IN ('shares', 'team'));
ALTER TABLE chain_balance_changes ALTER COLUMN token DROP DEFAULT;

UPDATE chain_balance_changes c SET token = 'team', project_key = l.project_key
FROM chain_logs l
WHERE l.reader = c.reader AND l.block_number = c.block_number AND l.log_index = c.log_index
  AND l.role = 'team' AND l.event = 'Transfer' AND l.project_key IS NOT NULL;

INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, token, delta)
SELECT l.reader, l.block_number, l.log_index, m.account, l.project_key, 'team', m.delta
FROM chain_logs l
CROSS JOIN LATERAL (VALUES
    (decode(substr(lower(l.decoded->>'from'), 3), 'hex'), -((l.decoded->>'value')::numeric)),
    (decode(substr(lower(l.decoded->>'to'), 3), 'hex'), (l.decoded->>'value')::numeric)
) AS m(account, delta)
WHERE l.role = 'team' AND l.event = 'Transfer'
  AND l.project_key IS NOT NULL
  AND l.decoded ? 'from' AND l.decoded ? 'to' AND l.decoded ? 'value'
  AND lower(l.decoded->>'from') <> lower(l.decoded->>'to')
  AND m.account <> '\x0000000000000000000000000000000000000000'::bytea
  AND NOT EXISTS (
      SELECT 1 FROM chain_balance_changes c
      WHERE c.reader = l.reader AND c.block_number = l.block_number AND c.log_index = l.log_index)
ON CONFLICT (reader, block_number, log_index, account) DO NOTHING;

DROP INDEX idx_chain_balance_changes_account;
CREATE INDEX idx_chain_balance_changes_account
    ON chain_balance_changes (reader, project_key, token, account, block_number);

ALTER TABLE chain_balances
    ADD COLUMN token TEXT NOT NULL DEFAULT 'shares' CHECK (token IN ('shares', 'team'));
ALTER TABLE chain_balances ALTER COLUMN token DROP DEFAULT;
ALTER TABLE chain_balances DROP CONSTRAINT chain_balances_pkey;
ALTER TABLE chain_balances ADD PRIMARY KEY (reader, project_key, token, account);

DELETE FROM chain_balances;
INSERT INTO chain_balances (reader, project_key, token, account, balance)
SELECT reader, project_key, token, account, sum(delta)
FROM chain_balance_changes
GROUP BY reader, project_key, token, account;

-- 3. The helper's call names.
ALTER TABLE chain_helper_jobs DROP CONSTRAINT chain_helper_jobs_call_check;
ALTER TABLE chain_helper_jobs ADD CONSTRAINT chain_helper_jobs_call_check CHECK (call IN
    ('treasury.collectFees', 'treasury.settle',
     'rounds.close', 'rounds.settleMany', 'rounds.release', 'rounds.returnUnsold',
     'rounds.sweepFees', 'treasury.sweepFees', 'treasury.release',
     'finisher.openPool', 'finisher.settle', 'finisher.sweep', 'finisher.abandon',
     'holder.collect', 'vester.claim', 'earlier.deliverMany'));

UPDATE chain_helper_jobs SET call = CASE call
        WHEN 'treasury.sweepFees' THEN 'treasury.collectFees'
        ELSE 'treasury.settle' END
WHERE call IN ('treasury.sweepFees', 'treasury.release')
  AND reader IN (SELECT reader FROM chain_contracts WHERE role = 'team');
