-- The contracts the reader follows: the Launcher, and each project's Shares,
-- Treasury, Vester, Finisher, Rounds and Pair, found in the Launcher's events,
-- and project zero's earlier backers' claim contract (migration 0066 widened
-- the role list; auction, holder and pool_manager are reserved). `team` is a
-- project's Team Shares token (migration 0070); `tasks` is a project's task
-- book, found from its Treasury's `TasksReady` log (migration 0071); `pause`
-- is a project's holder pause, found from its Treasury's `PauseReady` log, and
-- `earlier` the claim contract, found from the Launcher's `EarlierBound` log
-- (migration 0076).
-- `from_block` is where it was found, so a rollback past it forgets it.
CREATE TABLE chain_contracts (
    reader       TEXT NOT NULL,
    address      BYTEA NOT NULL CHECK (length(address) = 20),
    role         TEXT NOT NULL CHECK (role IN
                     ('launcher', 'shares', 'team', 'treasury', 'vester', 'tasks', 'finisher', 'rounds', 'pair',
                      'earlier', 'auction', 'holder', 'pool_manager', 'pause')),
    project_key  BYTEA CHECK (project_key IS NULL OR length(project_key) = 32),
    from_block   BIGINT NOT NULL CHECK (from_block >= 0),
    PRIMARY KEY (reader, address)
);

CREATE INDEX idx_chain_contracts_from_block ON chain_contracts (reader, from_block);
