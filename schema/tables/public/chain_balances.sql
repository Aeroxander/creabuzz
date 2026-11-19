-- Each project's Shares balances, by token ('shares' for the backer Shares,
-- 'team' for the Team Shares), kept as the chain reader commits ranges
-- (migrations 0067 and 0070).
CREATE TABLE chain_balances (
    reader       TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    project_key  BYTEA NOT NULL CHECK (length(project_key) = 32),
    account      BYTEA NOT NULL CHECK (length(account) = 20),
    balance      NUMERIC(78, 0) NOT NULL,
    token        TEXT NOT NULL CHECK (token IN ('shares', 'team')),
    PRIMARY KEY (reader, project_key, token, account)
);
