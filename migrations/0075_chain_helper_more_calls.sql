-- ── Chain reader: three more calls the helper may send ───────────────────────
--
-- The helper (crates/buzz-relay/src/chain_reader/helper) sent two calls that
-- anyone may make: collecting the platform's fee and settling a project. It
-- now also applies a proposed allowance rate whose wait has ended, burns a
-- grant's announced part when its notice has run, and burns what a grant does
-- not keep after a wind-down. Nobody's money waits on them: they only close
-- notices that were already public.
--
-- chain_helper_jobs.call may be, besides the retired names that stay allowed so
-- history of earlier readers stays valid, exactly:
--   'treasury.collectFees', 'treasury.settle', 'treasury.applyRate',
--   'vester.execute', 'vester.burnAfterWindDown'.
-- `Treasury.windDown()` is NOT among them: ending a project is a person's press.

ALTER TABLE chain_helper_jobs DROP CONSTRAINT chain_helper_jobs_call_check;
ALTER TABLE chain_helper_jobs ADD CONSTRAINT chain_helper_jobs_call_check CHECK (call IN
    ('treasury.collectFees', 'treasury.settle',
     'treasury.applyRate', 'vester.execute', 'vester.burnAfterWindDown',
     'rounds.close', 'rounds.settleMany', 'rounds.release', 'rounds.returnUnsold',
     'rounds.sweepFees', 'treasury.sweepFees', 'treasury.release',
     'finisher.openPool', 'finisher.settle', 'finisher.sweep', 'finisher.abandon',
     'holder.collect', 'vester.claim', 'earlier.deliverMany'));
