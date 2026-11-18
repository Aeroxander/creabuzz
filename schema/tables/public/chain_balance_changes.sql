-- Each Shares balance change with the block and log it came from, so a
-- rollback takes it back out of chain_balances (migration 0067).
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
