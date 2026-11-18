-- Locked and pinned threads. A row with neither is deleted, not kept.
CREATE TABLE board_thread_state (
    community_id    UUID NOT NULL REFERENCES communities(id),
    channel_id      UUID NOT NULL,
    root_event_id   BYTEA NOT NULL CHECK (length(root_event_id) = 32),
    locked_at       TIMESTAMPTZ,
    locked_by       BYTEA CHECK (locked_by IS NULL OR length(locked_by) = 32),
    pinned_at       TIMESTAMPTZ,
    pinned_by       BYTEA CHECK (pinned_by IS NULL OR length(pinned_by) = 32),
    PRIMARY KEY (community_id, channel_id, root_event_id),
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id),
    CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
    CHECK ((pinned_at IS NULL) = (pinned_by IS NULL))
);

CREATE INDEX idx_board_thread_state_pinned
    ON board_thread_state (community_id, channel_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL;
CREATE INDEX idx_board_thread_state_locked
    ON board_thread_state (community_id, channel_id, locked_at DESC)
    WHERE locked_at IS NOT NULL;
