-- One row per log read: where it came from, the raw topics and data, and the
-- decoded fields (JSON; every integer as a decimal string).
CREATE TABLE chain_logs (
    reader       TEXT NOT NULL,
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    log_index    INTEGER NOT NULL CHECK (log_index >= 0),
    block_hash   BYTEA NOT NULL CHECK (length(block_hash) = 32),
    tx_hash      BYTEA NOT NULL CHECK (length(tx_hash) = 32),
    address      BYTEA NOT NULL CHECK (length(address) = 20),
    role         TEXT NOT NULL,
    project_key  BYTEA CHECK (project_key IS NULL OR length(project_key) = 32),
    event        TEXT NOT NULL CHECK (octet_length(event) BETWEEN 1 AND 64),
    topics       BYTEA[] NOT NULL,
    data         BYTEA NOT NULL,
    decoded      JSONB,
    PRIMARY KEY (reader, block_number, log_index)
);

CREATE INDEX idx_chain_logs_project ON chain_logs (reader, project_key, block_number, log_index);
-- The rows of the projects' task books, in block order (migration 0071).
CREATE INDEX idx_chain_logs_tasks ON chain_logs (reader, project_key, block_number) WHERE role = 'tasks';
-- The relay's task-rule lookups: the announced rows of one task record, and the takes and resolutions of one serial
-- (migration 0072).
CREATE INDEX idx_chain_logs_task_what ON chain_logs (reader, project_key, (lower(decoded->>'what')))
    WHERE role = 'tasks' AND event = 'TaskAnnounced';
CREATE INDEX idx_chain_logs_task_serial ON chain_logs (reader, project_key, (decoded->>'serial'))
    WHERE role = 'tasks' AND event IN ('TaskTaken', 'TaskResolved');
-- The draws of one transaction on one project's Treasury: the relay's check that a task named as paid out of the
-- allowance box was paid on the network (migration 0076).
CREATE INDEX idx_chain_logs_box_draws ON chain_logs (reader, project_key, tx_hash)
    WHERE role = 'treasury' AND event = 'AllowanceDrawn';
-- The helpers the network has set, by wallet: the relay's tie between the network's helper limits and the server's labels
-- (migration 0076).
CREATE INDEX idx_chain_logs_agent_set ON chain_logs (reader, (lower(decoded->>'agent')))
    WHERE role = 'treasury' AND event = 'AgentSet';
