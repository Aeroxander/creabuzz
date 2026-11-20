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
    -- What the signed record said about the money that stayed (migration 0073); null when it said nothing. The
    -- ranking index is built from these.
    rank_money       NUMERIC(78, 0) CHECK (rank_money IS NULL OR rank_money >= 0),
    rank_accounts    INTEGER CHECK (rank_accounts IS NULL OR rank_accounts >= 0),
    rank_window_secs BIGINT CHECK (rank_window_secs IS NULL OR rank_window_secs >= 0),
    reached          BOOLEAN,
    launched_at      BIGINT CHECK (launched_at IS NULL OR launched_at >= 0),
    PRIMARY KEY (reader, project_key)
);
