-- ── Chain reader: indexes for the relay's task-rule lookups ──
-- The relay reads the plan of a task record on every take, accept, confirm and
-- cancel of a planned task: the book's `TaskAnnounced` rows that name the record
-- (its `what`), then the takes and resolutions of those serials. Any signed-in
-- account may send a take, so these reads must not scan a project's whole book
-- (which holds every note the project ever minted).
--
-- 1. The announced rows of one task record.
-- 2. The takes and resolutions of one serial.
-- Both are partial, so notes (the bulk of a book) are not in them.
--
-- Public chain facts in operator-global tables: nothing here is community-scoped.

CREATE INDEX idx_chain_logs_task_what ON chain_logs (reader, project_key, (lower(decoded->>'what')))
    WHERE role = 'tasks' AND event = 'TaskAnnounced';

CREATE INDEX idx_chain_logs_task_serial ON chain_logs (reader, project_key, (decoded->>'serial'))
    WHERE role = 'tasks' AND event IN ('TaskTaken', 'TaskResolved');
