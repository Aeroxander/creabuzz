-- ── Chain reader running totals (plan v2, milestone 5, part 2; review F5) ──
-- Each project's Shares balances are kept as the reader commits ranges, so a
-- check of a project no longer loads every Shares Transfer it ever made. A
-- balance change keeps the block and log it came from, so a rollback takes
-- exactly those back out of the totals in the same transaction that deletes
-- the logs. Public chain facts for the whole deployment: operator-global.

CREATE TABLE chain_balances (
    reader       TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    project_key  BYTEA NOT NULL CHECK (length(project_key) = 32),
    account      BYTEA NOT NULL CHECK (length(account) = 20),
    balance      NUMERIC(78, 0) NOT NULL,
    PRIMARY KEY (reader, project_key, account)
);

CREATE TABLE chain_balance_changes (
    reader       TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    log_index    INTEGER NOT NULL CHECK (log_index >= 0),
    account      BYTEA NOT NULL CHECK (length(account) = 20),
    project_key  BYTEA NOT NULL CHECK (length(project_key) = 32),
    delta        NUMERIC(78, 0) NOT NULL,
    PRIMARY KEY (reader, block_number, log_index, account)
);

CREATE INDEX idx_chain_balance_changes_account
    ON chain_balance_changes (reader, project_key, account, block_number);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('chain_balances', 'deployment-global Shares balances the chain reader keeps; public chain facts'),
    ('chain_balance_changes', 'deployment-global Shares balance changes by block, undone on a rollback');
