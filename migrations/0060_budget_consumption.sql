-- creabuzz: NIP-ORG budget enforcement — windowed consumption counters.
--
-- Tracks run/task creation/task approval counts per budget subject within
-- a rolling window. The relay increments counters on ingest and rejects
-- (or routes to approval) when limits are exceeded.
--
-- Spend ceilings are NOT tracked here — they are enforced at the value
-- layer (ACP harness signing path, or onchain for DAO-bound budgets).

CREATE TABLE budget_consumption (
    community_id    UUID NOT NULL REFERENCES communities(id),
    subject         VARCHAR(128) NOT NULL,
    counter_type    VARCHAR(32) NOT NULL,
    window_start    TIMESTAMPTZ NOT NULL,
    consumed        BIGINT NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, subject, counter_type, window_start)
);

CREATE INDEX idx_budget_consumption_lookup
    ON budget_consumption (community_id, subject, counter_type, window_start DESC);

-- Durable budget approval requests (NIP-ORG `onExceed: "require-approval"`).
--
-- Written BEFORE the best-effort kind:46010 notification, so a lost
-- notification never loses the request. `token` stores the hashed approval
-- token (same hashing scheme as workflow_approvals); PK leads with
-- community_id per the tenant-scoping lint. Grant/deny wiring for these
-- rows is a follow-up; the row is today the durable audit/recovery record.
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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
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
