-- ── Board moderation (D93) ───────────────────────────────────────────────────
-- Boards get their own moderation, limited to one board: locked and pinned
-- threads, visible rules, mutes that apply on this board only, and moderators
-- appointed by the board's owners and admins (or the community's) for a term.
-- Every accepted board command writes a moderation_actions row and a
-- relay-signed public log entry in the same transaction, and rebuilds the
-- board's relay-signed state record.
--
-- Additive migration: previously applied files must not change checksum. All
-- three tables are tenant data, so they carry community_id, reference the
-- board's channel, and take the community write fence (see 0061).

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

SELECT attach_community_write_fence('board_settings');
SELECT attach_community_write_fence('board_thread_state');
SELECT attach_community_write_fence('board_people');

-- The audit trail learns the board actions, and that an action was taken on the
-- authority of a board moderator appointment (rate-limited and guard-railed
-- differently from owners and admins). The constraint names are PostgreSQL's
-- defaults for the column CHECKs of 0006 and 0035.
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check CHECK (action IN (
    'delete_message', 'kick', 'ban', 'unban',
    'timeout', 'untimeout', 'dismiss_report', 'escalate',
    'resolve:delete', 'resolve:kick', 'resolve:ban',
    'resolve:timeout',
    'board_lock', 'board_unlock', 'board_pin', 'board_unpin',
    'board_mute', 'board_unmute', 'board_rules',
    'board_appoint', 'board_dismiss'));

ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_actor_authority_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_actor_authority_check
    CHECK (actor_authority IN ('community', 'relay_operator', 'relay_moderator', 'board_moderator'));

-- The rate limit counts one actor's recent board-moderator actions.
CREATE INDEX idx_moderation_actions_actor_recent
    ON moderation_actions (community_id, actor_pubkey, created_at DESC);
