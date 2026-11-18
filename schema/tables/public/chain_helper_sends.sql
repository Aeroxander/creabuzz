-- Every transaction the chain helper broadcast (migration 0066), with the gas
-- and fee reserved and then spent: what the daily caps count.
CREATE TABLE chain_helper_sends (
    reader          TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    tx_hash         BYTEA NOT NULL CHECK (length(tx_hash) = 32),
    job_id          BIGINT NOT NULL,
    nonce           BIGINT NOT NULL CHECK (nonce >= 0),
    gas_limit       BIGINT NOT NULL CHECK (gas_limit > 0),
    max_fee_per_gas NUMERIC(78, 0) NOT NULL CHECK (max_fee_per_gas >= 0),
    max_priority_fee_per_gas NUMERIC(78, 0) NOT NULL CHECK (max_priority_fee_per_gas >= 0),
    reserved_wei    NUMERIC(78, 0) NOT NULL CHECK (reserved_wei >= 0),
    gas_used        BIGINT CHECK (gas_used IS NULL OR gas_used >= 0),
    spent_wei       NUMERIC(78, 0) CHECK (spent_wei IS NULL OR spent_wei >= 0),
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at      TIMESTAMPTZ,
    PRIMARY KEY (reader, tx_hash)
);

CREATE INDEX idx_chain_helper_sends_sent_at ON chain_helper_sends (reader, sent_at);
