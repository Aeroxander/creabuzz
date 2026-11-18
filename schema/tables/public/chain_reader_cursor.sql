-- Where each reader has scanned to: the next block to read.
CREATE TABLE chain_reader_cursor (
    reader      TEXT PRIMARY KEY CHECK (octet_length(reader) BETWEEN 1 AND 128),
    next_block  BIGINT NOT NULL CHECK (next_block >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
