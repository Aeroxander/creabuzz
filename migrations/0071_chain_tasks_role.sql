-- ── Chain reader: the task book's role ──
-- Step 2 of contracts/pot gives each project one more contract, its task book
-- (`TaskBook`). The reader finds it from its Treasury's own `TasksReady` log
-- and follows it as role 'tasks' (the book's address is in no Launcher event).
--
-- 1. chain_contracts.role may be 'tasks'. Nothing is moved: a reader that ran
--    before this migration follows the book from the stored `TasksReady` rows
--    the next time it scans (the "late" discovery of the scan).
-- 2. A partial index for the rows of those books: the relay's task rules read
--    only these (a project's task events in block order), and they must not
--    scan a project's whole log.
--
-- Public chain facts in operator-global tables: nothing here is community-scoped.

ALTER TABLE chain_contracts DROP CONSTRAINT chain_contracts_role_check;
ALTER TABLE chain_contracts ADD CONSTRAINT chain_contracts_role_check CHECK (role IN
    ('launcher', 'shares', 'team', 'treasury', 'vester', 'tasks', 'finisher', 'rounds', 'pair',
     'earlier', 'auction', 'holder', 'pool_manager'));

CREATE INDEX idx_chain_logs_tasks ON chain_logs (reader, project_key, block_number)
    WHERE role = 'tasks';
