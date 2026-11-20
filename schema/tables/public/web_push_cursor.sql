-- Where the alert maker has read the chain's task rows to: the next block (migration 0074). Created at the reader's
-- current position when push is first switched on, so no history is ever alerted.
CREATE TABLE web_push_cursor (
    reader      TEXT PRIMARY KEY CHECK (octet_length(reader) BETWEEN 1 AND 128),
    next_block  BIGINT NOT NULL CHECK (next_block >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
