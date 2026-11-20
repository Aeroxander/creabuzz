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
