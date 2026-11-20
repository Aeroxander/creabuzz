-- Each Shares balance change with the block and log it came from, so a
-- rollback takes it back out of chain_balances (migrations 0067 and 0070).
CREATE TABLE chain_balance_changes (
    reader       TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    log_index    INTEGER NOT NULL CHECK (log_index >= 0),
    account      BYTEA NOT NULL CHECK (length(account) = 20),
    project_key  BYTEA NOT NULL CHECK (length(project_key) = 32),
    delta        NUMERIC(78, 0) NOT NULL,
    token        TEXT NOT NULL CHECK (token IN ('shares', 'team')),
    PRIMARY KEY (reader, block_number, log_index, account)
);

CREATE INDEX idx_chain_balance_changes_account
    ON chain_balance_changes (reader, project_key, token, account, block_number);

-- One project's Share changes in block order from a block on (migration 0073): the window query of the held
-- figures reads a range of this and stops at its row cap.
CREATE INDEX idx_chain_balance_changes_block
    ON chain_balance_changes (reader, project_key, token, block_number, log_index);
