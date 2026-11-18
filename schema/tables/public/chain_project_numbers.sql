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
