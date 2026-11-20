-- ── Web push alerts and the sponsored-fee limit (step 3, STEP3-PLAN.md section 6) ──
-- Alerts away from the app: a device's own push address (as little as it takes to send to it), where the alert maker has
-- read the chain's task rows to, one row per alert, and one row per alert and device with a lease, a growing pause
-- between tries and a terminal state. And the sponsored-fee limit: a count per key and UTC day.
--
-- Two tables carry `community_id` and are fenced (the device rows and the outbox); three are deployment-global (the
-- cursor, the alerts and the sponsor counts: public chain facts and counts keyed by day).

-- A device's own push address, as little as it takes to send to it (migration 0074). No name, user agent, address,
-- project or wallet is kept with it; the wallet is looked up when an alert is made. The person deletes their rows any
-- time (`DELETE /push/web`); a push service answering "gone" deletes the row; an expired row is swept.
CREATE TABLE web_push_subscriptions (
    community_id  UUID NOT NULL REFERENCES communities(id),
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    pubkey        BYTEA NOT NULL CHECK (length(pubkey) = 32),
    endpoint      TEXT NOT NULL CHECK (octet_length(endpoint) BETWEEN 1 AND 512),
    endpoint_hash BYTEA NOT NULL CHECK (length(endpoint_hash) = 32),
    p256dh        BYTEA NOT NULL CHECK (length(p256dh) = 65),
    auth          BYTEA NOT NULL CHECK (length(auth) = 16),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, pubkey, endpoint_hash)
);

CREATE INDEX web_push_subscriptions_account ON web_push_subscriptions (community_id, pubkey);
CREATE INDEX web_push_subscriptions_expiry ON web_push_subscriptions (community_id, expires_at);

-- Where the alert maker has read the chain's task rows to: the next block (migration 0074). Created at the reader's
-- current position when push is first switched on, so no history is ever alerted.
CREATE TABLE web_push_cursor (
    reader      TEXT PRIMARY KEY CHECK (octet_length(reader) BETWEEN 1 AND 128),
    next_block  BIGINT NOT NULL CHECK (next_block >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- How many sponsored fees one key has used on one UTC day (migration 0074): a request reserves its count in the
-- statement that checks the limit and gives it back when the upstream refuses. The key says what is counted
-- (`acct:<sender>`, `all`, `ip:<address>`, `exit-ip:<address>`).
CREATE TABLE sponsor_usage (
    day   DATE NOT NULL,
    key   TEXT NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 160),
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (day, key)
);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('web_push_cursor', 'deployment-global position of the web push alert maker; public chain facts'),
    ('web_push_alerts', 'deployment-global task alerts made from public chain rows'),
    ('sponsor_usage', 'deployment-global count of sponsored fees by day and key');

SELECT attach_community_write_fence('web_push_subscriptions');
SELECT attach_community_write_fence('web_push_outbox');
