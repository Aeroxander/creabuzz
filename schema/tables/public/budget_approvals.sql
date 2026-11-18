-- Durable budget approval requests (NIP-ORG `onExceed: "require-approval"`).
-- Written BEFORE the best-effort kind:46010 notification, so a lost
-- notification never loses the request. `token` stores the hashed approval
-- token (same hashing scheme as workflow_approvals).
CREATE TABLE budget_approvals (
    community_id    UUID NOT NULL REFERENCES communities(id),
    token           BYTEA NOT NULL,
    subject         VARCHAR(128) NOT NULL,
    counter_type    VARCHAR(32) NOT NULL,
    window_start    TIMESTAMPTZ NOT NULL,
    limit_value     BIGINT NOT NULL,
    budget_event_id TEXT,
    status          approval_status NOT NULL DEFAULT 'pending',
    approver_pubkey BYTEA,
    note            TEXT,
    granted_at      TIMESTAMPTZ,
    denied_at       TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, token)
);

CREATE INDEX idx_budget_approvals_subject
    ON budget_approvals (community_id, subject, status);

-- One pending request per (subject, counter, window): repeated overrun
-- attempts refresh the existing request instead of growing the table
-- without bound. Resolved (granted/denied/expired) rows are unconstrained.
CREATE UNIQUE INDEX idx_budget_approvals_one_pending
    ON budget_approvals (community_id, subject, counter_type, window_start)
    WHERE status = 'pending';
