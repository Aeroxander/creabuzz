-- ── Chain reader (plan v2, milestone 5) ─────────────────────────────────────
-- The server reads the contracts/next events (Launcher, Rounds, Vester,
-- Treasury, Finisher, Pair, the project's Shares) into these tables and signs
-- one "project numbers" record (kind 39009) per project from them.
--
-- Every row carries the block it came from, so a chain rollback (reorg) can be
-- undone: the reader keeps the hash of every block it stored a log from and of
-- the last block it scanned, finds the fork point by comparing those hashes
-- with the chain, and deletes every row past it. Rows are treated as final only
-- once they are deeper than the configured confirmation depth.
--
-- The rows are public chain facts, not one community's data: a deployment runs
-- one reader per (chain, Launcher), named by `reader` = '<chain id>:<launcher>'.
-- The tables are therefore registered as operator-global (no community_id);
-- the records the reader signs go into the configured community's events.
-- Additive migration.

-- Where each reader has scanned to: the next block to read.
CREATE TABLE chain_reader_cursor (
    reader      TEXT PRIMARY KEY CHECK (octet_length(reader) BETWEEN 1 AND 128),
    next_block  BIGINT NOT NULL CHECK (next_block >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The blocks the reader relies on: each block a stored log came from, and the
-- last block it scanned. Their hashes find the fork point after a rollback.
CREATE TABLE chain_blocks (
    reader       TEXT NOT NULL,
    number       BIGINT NOT NULL CHECK (number >= 0),
    hash         BYTEA NOT NULL CHECK (length(hash) = 32),
    parent_hash  BYTEA NOT NULL CHECK (length(parent_hash) = 32),
    block_time   BIGINT NOT NULL CHECK (block_time >= 0),
    PRIMARY KEY (reader, number)
);

-- The contracts the reader follows: the Launcher, and each project's Shares,
-- Treasury, Vester, Finisher, Rounds and Pair, found in the Launcher's events.
-- `from_block` is where it was found, so a rollback past it forgets it.
CREATE TABLE chain_contracts (
    reader       TEXT NOT NULL,
    address      BYTEA NOT NULL CHECK (length(address) = 20),
    role         TEXT NOT NULL CHECK (role IN
                     ('launcher', 'shares', 'treasury', 'vester', 'finisher', 'rounds', 'pair')),
    project_key  BYTEA CHECK (project_key IS NULL OR length(project_key) = 32),
    from_block   BIGINT NOT NULL CHECK (from_block >= 0),
    PRIMARY KEY (reader, address)
);

CREATE INDEX idx_chain_contracts_from_block ON chain_contracts (reader, from_block);

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

-- The last "project numbers" record signed for each project, so the reader
-- republishes only when the numbers change. A failed publish leaves the old row
-- in place, so the next pass tries again. A rollback past `source_block` marks
-- the row `stale`, so the numbers are worked out again from the new rows.
CREATE TABLE chain_project_numbers (
    reader         TEXT NOT NULL,
    project_key    BYTEA NOT NULL CHECK (length(project_key) = 32),
    source_block   BIGINT NOT NULL CHECK (source_block >= 0),
    facts_digest   BYTEA NOT NULL CHECK (length(facts_digest) = 32),
    content_digest BYTEA NOT NULL CHECK (length(content_digest) = 32),
    event_id       BYTEA NOT NULL CHECK (length(event_id) = 32),
    published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    stale          BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (reader, project_key)
);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('chain_reader_cursor', 'deployment-global chain reader position; public chain facts'),
    ('chain_blocks', 'deployment-global chain reader block hashes; public chain facts'),
    ('chain_contracts', 'deployment-global contracts the chain reader follows; public chain facts'),
    ('chain_logs', 'deployment-global contract events read from the chain; public chain facts'),
    ('chain_project_numbers', 'deployment-global record of the project numbers the reader signed');
