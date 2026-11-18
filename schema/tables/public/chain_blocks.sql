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
