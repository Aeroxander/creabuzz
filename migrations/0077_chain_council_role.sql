-- ── Chain reader: a project's Council, the helper's vote calls, the vote alerts ──
--
-- Milestone 9 of the new model (contracts/pot, `COUNCIL-PLAN.md` sections 5.1, 5.5 and 5.6): a project may hand its
-- seat to a Council (`Council`, found from the Launcher's `CouncilMade` log) and its holder pause is then a
-- `HolderVote` that runs replace votes and seat elections. The relay follows that Council, the helper sends the four
-- vote calls anyone may make, and the alert maker may now tell a holder a vote opened or a vote moved the runner.
--
-- 1. chain_contracts.role may be 'council'. Nothing is moved: a reader that ran before this migration finds the
--    Council from the stored `CouncilMade` rows the next time it scans (the "late" discovery of the scan). The
--    vote contract needs no new role: it is the project's pause (`PauseReady`), which has been a role since 0076.
-- 2. chain_helper_jobs.call may be the four vote calls, each anyone may make and moving no money:
--    'vote.openSeats', 'vote.finish', 'vote.carryOut', 'vote.lapse'. The helper still never opens a replace vote
--    (`openReplace` is a holder's press), and the retired names stay allowed so earlier readers' history stays valid.
-- 3. web_push_alerts.kind may be 'vote' (a ballot opened) and 'moved' (the reader's own derived result says the
--    runner changes), so the alert maker's rows insert.
--
-- Public chain facts and the relay's own outgoing calls, operator-global: nothing here is community-scoped.

ALTER TABLE chain_contracts DROP CONSTRAINT chain_contracts_role_check;
ALTER TABLE chain_contracts ADD CONSTRAINT chain_contracts_role_check CHECK (role IN
    ('launcher', 'shares', 'team', 'treasury', 'vester', 'tasks', 'finisher', 'rounds', 'pair',
     'earlier', 'auction', 'holder', 'pool_manager', 'pause', 'council'));

ALTER TABLE chain_helper_jobs DROP CONSTRAINT chain_helper_jobs_call_check;
ALTER TABLE chain_helper_jobs ADD CONSTRAINT chain_helper_jobs_call_check CHECK (call IN
    ('treasury.collectFees', 'treasury.settle',
     'treasury.applyRate', 'vester.execute', 'vester.burnAfterWindDown',
     'vote.openSeats', 'vote.finish', 'vote.carryOut', 'vote.lapse',
     'rounds.close', 'rounds.settleMany', 'rounds.release', 'rounds.returnUnsold',
     'rounds.sweepFees', 'treasury.sweepFees', 'treasury.release',
     'finisher.openPool', 'finisher.settle', 'finisher.sweep', 'finisher.abandon',
     'holder.collect', 'vester.claim', 'earlier.deliverMany', 'pause.poke'));

ALTER TABLE web_push_alerts DROP CONSTRAINT web_push_alerts_kind_check;
ALTER TABLE web_push_alerts ADD CONSTRAINT web_push_alerts_kind_check CHECK (kind IN
    ('planned', 'taken', 'ended', 'vote', 'moved'));
