-- A board's own settings: its rules, shown on the board.
CREATE TABLE board_settings (
    community_id    UUID NOT NULL REFERENCES communities(id),
    channel_id      UUID NOT NULL,
    rules           TEXT NOT NULL DEFAULT '' CHECK (length(rules) <= 4000),
    rules_set_by    BYTEA CHECK (rules_set_by IS NULL OR length(rules_set_by) = 32),
    rules_set_at    TIMESTAMPTZ,
    PRIMARY KEY (community_id, channel_id),
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id)
);
