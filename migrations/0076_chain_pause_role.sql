-- ── Chain reader: the holder pause's role, and its one permissionless call ──
-- Step 4 of contracts/pot gives a project a holder pause (`HolderPause`, only when the deployment's switch is on),
-- found from its Treasury's `PauseReady` log, and a deployment an earlier backers' claim contract (`EarlierGrants`),
-- found from the Launcher's `EarlierBound` log.
--
-- 1. chain_contracts.role may be 'pause'. The claim contract uses the role 'earlier', which the list has allowed
--    since migration 0066 and no code used before. Nothing is moved: a reader that ran before this migration follows
--    the pause from the stored `PauseReady` rows the next time it scans (the "late" discovery of the scan).
-- 2. chain_helper_jobs.call may be 'pause.poke' (`HolderPause.poke()`: anyone may call it; it looks at the ratio of
--    parked to all backer Shares and moves nothing else).
--
-- 3. A partial index for the relay's check of a task paid out of the allowance box: the draws of one transaction on
--    one project's Treasury (`task_chain::BOX_DRAWS_SQL`), so a confirm that names a payment never scans a project's
--    whole history.
--
-- 4. A partial index for the relay's tie between the network's helper limits and the server's labels: the
--    `AgentSet` rows of one wallet (`chain_agent_link::LIVE_HELPERS_SQL`).
--
-- Public chain facts in operator-global tables: nothing here is community-scoped.

ALTER TABLE chain_contracts DROP CONSTRAINT chain_contracts_role_check;
ALTER TABLE chain_contracts ADD CONSTRAINT chain_contracts_role_check CHECK (role IN
    ('launcher', 'shares', 'team', 'treasury', 'vester', 'tasks', 'finisher', 'rounds', 'pair',
     'earlier', 'auction', 'holder', 'pool_manager', 'pause'));

ALTER TABLE chain_helper_jobs DROP CONSTRAINT chain_helper_jobs_call_check;
ALTER TABLE chain_helper_jobs ADD CONSTRAINT chain_helper_jobs_call_check CHECK (call IN
    ('treasury.collectFees', 'treasury.settle',
     'treasury.applyRate', 'vester.execute', 'vester.burnAfterWindDown',
     'rounds.close', 'rounds.settleMany', 'rounds.release', 'rounds.returnUnsold',
     'rounds.sweepFees', 'treasury.sweepFees', 'treasury.release',
     'finisher.openPool', 'finisher.settle', 'finisher.sweep', 'finisher.abandon',
     'holder.collect', 'vester.claim', 'earlier.deliverMany', 'pause.poke'));

CREATE INDEX idx_chain_logs_box_draws ON chain_logs (reader, project_key, tx_hash)
    WHERE role = 'treasury' AND event = 'AllowanceDrawn';

CREATE INDEX idx_chain_logs_agent_set ON chain_logs (reader, (lower(decoded->>'agent')))
    WHERE role = 'treasury' AND event = 'AgentSet';
