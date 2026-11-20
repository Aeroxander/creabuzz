-- One row per task event worth telling people about (migration 0074): planned, taken or ended, from the chain's own
-- rows. The unique key makes a repeated pass or a restart make no second alert. `link_ref` is the part of the
-- project's link after `/p/` (null when the project's record could not be found: the alert then reaches nobody).
CREATE TABLE web_push_alerts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reader       TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    project_key  BYTEA NOT NULL CHECK (length(project_key) = 32),
    serial       BIGINT NOT NULL CHECK (serial >= 0),
    kind         TEXT NOT NULL CHECK (kind IN ('planned', 'taken', 'ended')),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    link_ref     TEXT CHECK (link_ref IS NULL OR octet_length(link_ref) BETWEEN 1 AND 160),
    audience     INTEGER NOT NULL DEFAULT 0 CHECK (audience >= 0),
    cut          INTEGER NOT NULL DEFAULT 0 CHECK (cut >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (reader, project_key, serial, kind)
);

CREATE INDEX web_push_alerts_block ON web_push_alerts (reader, block_number);
CREATE INDEX web_push_alerts_created ON web_push_alerts (created_at);
