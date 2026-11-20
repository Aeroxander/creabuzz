-- One row per alert and device (migration 0074): claimed with a lease, retried with a growing pause, ending in a
-- terminal state (`delivered`, `gone`, `dropped` or `failed`). A device that is deleted takes its rows with it.
CREATE TABLE web_push_outbox (
    community_id    UUID NOT NULL REFERENCES communities(id),
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    alert_id        BIGINT NOT NULL CHECK (alert_id > 0),
    subscription_id UUID NOT NULL,
    project_key     BYTEA NOT NULL CHECK (length(project_key) = 32),
    state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                        ('pending', 'sending', 'delivered', 'gone', 'dropped', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until     TIMESTAMPTZ,
    last_status     INTEGER,
    last_error      TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 200),
    drop_reason     TEXT CHECK (drop_reason IS NULL OR drop_reason IN ('daily_cap', 'project_cap')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at         TIMESTAMPTZ,
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, alert_id, subscription_id),
    FOREIGN KEY (community_id, subscription_id)
        REFERENCES web_push_subscriptions (community_id, id) ON DELETE CASCADE
);

CREATE INDEX web_push_outbox_due
    ON web_push_outbox (community_id, next_attempt_at) WHERE state = 'pending';
CREATE INDEX web_push_outbox_recovery
    ON web_push_outbox (community_id, lease_until) WHERE state = 'sending';
CREATE INDEX web_push_outbox_device_day ON web_push_outbox (community_id, subscription_id, created_at);
