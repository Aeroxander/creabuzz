-- Each project's Shares balances, kept as the chain reader commits ranges
-- (migration 0067).
CREATE TABLE chain_balances (
    reader       TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    project_key  BYTEA NOT NULL CHECK (length(project_key) = 32),
    account      BYTEA NOT NULL CHECK (length(account) = 20),
    balance      NUMERIC(78, 0) NOT NULL,
    PRIMARY KEY (reader, project_key, account)
);
