-- One row per person per board: their board mute, a moderator's pending request
-- to mute them for longer than one moderator may (waiting for a second
-- moderator), and their appointment as a moderator of this board.
CREATE TABLE board_people (
    community_id            UUID NOT NULL REFERENCES communities(id),
    channel_id              UUID NOT NULL,
    pubkey                  BYTEA NOT NULL CHECK (length(pubkey) = 32),
    muted_until             TIMESTAMPTZ,
    muted_by                BYTEA CHECK (muted_by IS NULL OR length(muted_by) = 32),
    mute_reason             TEXT,
    longer_mute_until       TIMESTAMPTZ,
    longer_mute_by          BYTEA CHECK (longer_mute_by IS NULL OR length(longer_mute_by) = 32),
    longer_mute_asked_at    TIMESTAMPTZ,
    moderator_until         TIMESTAMPTZ,
    appointed_by            BYTEA CHECK (appointed_by IS NULL OR length(appointed_by) = 32),
    appointed_at            TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, channel_id, pubkey),
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id),
    CHECK ((muted_until IS NULL) = (muted_by IS NULL)),
    CHECK ((longer_mute_until IS NULL) = (longer_mute_by IS NULL)),
    CHECK ((moderator_until IS NULL) = (appointed_by IS NULL))
);

CREATE INDEX idx_board_people_moderators
    ON board_people (community_id, channel_id)
    WHERE moderator_until IS NOT NULL;
