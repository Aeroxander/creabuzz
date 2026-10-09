-- NIP-ORG budget enforcement (migration 0060): windowed consumption counters
-- per budget subject. The relay increments counters on ingest and rejects
-- (or routes to approval) when limits are exceeded. Spend ceilings are NOT
-- tracked here — they are enforced at the value layer.
CREATE TABLE budget_consumption (
    community_id    UUID NOT NULL REFERENCES communities(id),
    subject         VARCHAR(128) NOT NULL,
    counter_type    VARCHAR(32) NOT NULL,
    window_start    TIMESTAMPTZ NOT NULL,
    consumed        BIGINT NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, subject, counter_type, window_start)
);

CREATE INDEX idx_budget_consumption_lookup
    ON budget_consumption (community_id, subject, counter_type, window_start DESC);
