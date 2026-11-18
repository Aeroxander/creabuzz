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
